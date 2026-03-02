import json
import boto3
from datetime import datetime
from strands import Agent
from strands.tools.mcp import MCPClient
from mcp.client.streamable_http import streamablehttp_client
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from bedrock_agentcore.identity import requires_access_token

app = BedrockAgentCoreApp()


def _init_gateway_config() -> tuple[str, str]:
    """
    コンテナ起動時に Secrets Manager から gatewayUrl と scopes を読み込む。
    M2M 認証情報（clientId/clientSecret）は AgentCore Identity に移管済みのため不要。
    """
    try:
        sm_client = boto3.client("secretsmanager", region_name="us-west-2")
        secret_value = sm_client.get_secret_value(
            SecretId="agentcore-gateway-config"
        )
        config = json.loads(secret_value["SecretString"])
        return config.get("gatewayUrl", ""), config.get("scopes", "gateway-main/invoke")
    except Exception as e:
        print(f"[WARNING] Gateway設定の読み込みに失敗しました: {e}")
        return "", "gateway-main/invoke"


# コンテナ起動時に一度だけ設定を読み込む（以降はキャッシュを再利用）
_GATEWAY_URL, _GATEWAY_SCOPE = _init_gateway_config()


@requires_access_token(
    provider_name="gateway-m2m-oauth",  # Identity に登録した CustomOauth2 プロバイダー名
    scopes=[_GATEWAY_SCOPE],             # e.g. ["gateway-main/invoke"]
    auth_flow="M2M",                     # client_credentials フロー（ユーザー操作不要）
    into="access_token",                 # トークンを注入するキーワード引数名
)
async def _fetch_gateway_token(*, access_token: str) -> str:
    """
    AgentCore Identity から Gateway M2M アクセストークンを取得する。

    @requires_access_token デコレータが Cognito client_credentials フローを自動実行し、
    取得したトークンを access_token パラメータに注入する。
    手動での OAuth2 リクエスト（httpx.post）は不要。
    """
    return access_token


def convert_event(event) -> dict | None:
    """Strands のストリーミングイベントをフロントエンド向けの形式に変換する"""
    try:
        if not hasattr(event, "get"):
            return None
        inner_event = event.get("event")
        if not inner_event:
            return None

        # テキストデルタイベント（AIの応答テキスト）
        content_block_delta = inner_event.get("contentBlockDelta")
        if content_block_delta:
            delta = content_block_delta.get("delta", {})
            text = delta.get("text")
            if text:
                return {"type": "text", "data": text}

        # ツール使用開始イベント（Gatewayのツールを呼び出している）
        content_block_start = inner_event.get("contentBlockStart")
        if content_block_start:
            start = content_block_start.get("start", {})
            tool_use = start.get("toolUse")
            if tool_use:
                tool_name = tool_use.get("name", "unknown")
                return {"type": "tool_use", "tool_name": tool_name}

        return None
    except Exception:
        return None


@app.entrypoint
async def invoke_agent(payload, context):
    """
    AgentCore Runtime のエントリポイント

    処理フロー:
    1. @requires_access_token デコレータが Identity 経由で M2M トークンを自動取得
    2. AgentCore Gateway に MCP クライアントとして接続
    3. Gateway 経由で Tavily 検索ツールを使って Strands Agent を実行
    4. ストリーミングレスポンスをフロントエンドへ送信
    """
    prompt = payload.get("prompt", "")

    try:
        # Identity サービスから M2M アクセストークンを自動取得
        # （@requires_access_token デコレータが Cognito client_credentials フローを実行）
        token = await _fetch_gateway_token()

        # AgentCore Gateway に MCP クライアントとして接続
        mcp_client = MCPClient(
            lambda: streamablehttp_client(
                url=_GATEWAY_URL,
                headers={"Authorization": f"Bearer {token}"},
            ),
        )

        with mcp_client:
            # Gateway が提供する全ツールを取得してから手動フィルタリング
            # ※ tool_filters パラメータはプレフィックス付与前のRAW名でマッチするため
            #   "tavily-search___searchWeb" では機能しない。list_tools_sync() 後に
            #   tool_name 属性（プレフィックス済み）でフィルタする。
            all_tools = mcp_client.list_tools_sync()
            all_tool_names = [getattr(t, "tool_name", str(t)) for t in all_tools]
            print(f"[DEBUG] Gateway全ツール: {all_tool_names}")

            TARGET_TOOL = "tavily-search___searchWeb"
            tools = [t for t in all_tools if getattr(t, "tool_name", "") == TARGET_TOOL]
            print(f"[DEBUG] フィルタ後ツール: {[getattr(t, 'tool_name', str(t)) for t in tools]}")

            if not tools:
                # ターゲットツールが見つからない場合は全ツールを使用（フォールバック）
                print(f"[WARNING] {TARGET_TOOL} が見つかりません。全ツールを使用: {all_tool_names}")
                tools = all_tools

            # 現在の日付を動的に注入（モデルのトレーニングカットオフによる誤った年の使用を防ぐ）
            today = datetime.now().strftime("%Y年%m月%d日")
            agent = Agent(
                model="us.anthropic.claude-haiku-4-5-20251001-v1:0",
                system_prompt=(
                    f"現在の日付は {today} です。"
                    "あなたは親切で有能なAIアシスタントです。"
                    "日本語で丁寧に回答してください。"
                    "Webインターネット検索が必要な場合は tavily-search___searchWeb ツールを使って"
                    "最新情報を調べてください。"
                    "検索クエリには必ず現在の年を使用してください。"
                    "出典URLも含めて分かりやすく回答してください。"
                ),
                tools=tools,
            )

            async for event in agent.stream_async(prompt):
                converted = convert_event(event)
                if converted:
                    yield converted

    except Exception as e:
        # Gateway 接続に失敗した場合はツールなしで応答（フォールバック）
        error_info = str(e)
        today = datetime.now().strftime("%Y年%m月%d日")

        agent = Agent(
            model="us.anthropic.claude-haiku-4-5-20251001-v1:0",
            system_prompt=(
                f"現在の日付は {today} です。"
                "あなたは親切で有能なAIアシスタントです。"
                "日本語で丁寧に回答してください。"
                f"（注意: 検索ツールが利用できません。理由: {error_info}）"
            ),
        )

        async for event in agent.stream_async(prompt):
            converted = convert_event(event)
            if converted:
                yield converted


if __name__ == "__main__":
    app.run()
