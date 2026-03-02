import json
import boto3
import httpx
from strands import Agent, tool
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

# Tavily APIキーのキャッシュ（コンテナ起動中は再利用）
_tavily_api_key = None


def load_tavily_key() -> str:
    """Secrets Manager から Tavily API キーを読み込む"""
    global _tavily_api_key
    if _tavily_api_key is None:
        sm_client = boto3.client("secretsmanager", region_name="us-west-2")
        secret_value = sm_client.get_secret_value(
            SecretId="agentcore-tavily-apikey"
        )
        _tavily_api_key = secret_value["SecretString"]
    return _tavily_api_key


@tool
def search_web(query: str, max_results: int = 5) -> str:
    """
    Search the internet for up-to-date information using Tavily Search API.

    Args:
        query: The search query to look up on the internet
        max_results: Maximum number of search results to return (default: 5)

    Returns:
        Search results with titles, URLs, and content snippets
    """
    api_key = load_tavily_key()
    response = httpx.post(
        "https://api.tavily.com/search",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={"query": query, "max_results": max_results},
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()

    results = data.get("results", [])
    answer = data.get("answer", "")

    output_parts = []
    if answer:
        output_parts.append(f"**概要**: {answer}\n")

    output_parts.append("**検索結果**:")
    for r in results:
        title = r.get("title", "No title")
        url = r.get("url", "")
        content = r.get("content", "")[:400]
        output_parts.append(f"- [{title}]({url})\n  {content}")

    return "\n".join(output_parts)


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

        # ツール使用開始イベント（Tavily検索を呼び出している）
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
    1. Tavily API キーを Secrets Manager から取得
    2. Strands @tool として Tavily 検索を定義
    3. Strands Agent で Claude を実行（web 検索ツール付き）
    4. ストリーミングレスポンスをフロントエンドへ送信
    """
    prompt = payload.get("prompt", "")

    try:
        agent = Agent(
            model="us.anthropic.claude-haiku-4-5-20251001-v1:0",
            system_prompt=(
                "あなたは親切で有能なAIアシスタントです。"
                "日本語で丁寧に回答してください。"
                "インターネット検索ツール(search_web)を使って最新情報を調べることができます。"
                "質問に最新情報が必要な場合は積極的に検索ツールを活用し、"
                "出典URLも含めて分かりやすく回答してください。"
            ),
            tools=[search_web],
        )

        async for event in agent.stream_async(prompt):
            converted = convert_event(event)
            if converted:
                yield converted

    except Exception as e:
        # 検索ツールの初期化に失敗した場合はツールなしで応答（フォールバック）
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
