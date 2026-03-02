import json
import boto3
import httpx
from strands import Agent
from strands.tools.mcp import MCPClient
from mcp.client.streamable_http import streamablehttp_client
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

# Gateway設定のキャッシュ（コンテナ起動中は再利用）
_gateway_config = None


def load_gateway_config() -> dict:
    """Secrets Manager から AgentCore Gateway の M2M 接続情報を読み込む"""
    global _gateway_config
    if _gateway_config is None:
        sm_client = boto3.client("secretsmanager", region_name="us-west-2")
        secret_value = sm_client.get_secret_value(
            SecretId="agentcore-gateway-config"
        )
        _gateway_config = json.loads(secret_value["SecretString"])
    return _gateway_config


def get_oauth_token(config: dict) -> str:
    """
    Cognito を使った OAuth2 クライアント認証フロー（client_credentials）で
    AgentCore Gateway へのアクセストークンを取得する
    """
    response = httpx.post(
        config["tokenEndpoint"],
        data={
            "grant_type": "client_credentials",
            "client_id": config["clientId"],
            "client_secret": config["clientSecret"],
            "scope": config["scopes"],
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["access_token"]


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
    1. Gateway の M2M 認証情報を Secrets Manager から取得
    2. OAuth2 クライアント認証でアクセストークンを取得
    3. AgentCore Gateway に MCP クライアントとして接続
    4. Gateway 経由で Tavily 検索ツールを使って Strands Agent を実行
    5. ストリーミングレスポンスをフロントエンドへ送信
    """
    prompt = payload.get("prompt", "")

    try:
        # Gateway 接続情報を取得
        config = load_gateway_config()
        token = get_oauth_token(config)
        gateway_url = config["gatewayUrl"]

        # AgentCore Gateway に MCP クライアントとして接続
        # Gateway が Tavily 検索ツールを MCP ツールとして提供する
        mcp_client = MCPClient(
            lambda: streamablehttp_client(
                url=gateway_url,
                headers={"Authorization": f"Bearer {token}"},
            )
        )

        with mcp_client:
            # Gateway が提供するツール一覧を取得（Tavily 検索など）
            tools = mcp_client.list_tools_sync()

            agent = Agent(
                model="us.anthropic.claude-haiku-4-5-20251001-v1:0",
                system_prompt=(
                    "あなたは親切で有能なAIアシスタントです。"
                    "日本語で丁寧に回答してください。"
                    "インターネット検索ツール(searchWeb)を使って最新情報を調べることができます。"
                    "質問に最新情報が必要な場合は積極的に検索ツールを活用し、"
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

        agent = Agent(
            model="us.anthropic.claude-haiku-4-5-20251001-v1:0",
            system_prompt=(
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
