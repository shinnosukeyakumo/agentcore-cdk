from strands import Agent
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()


def convert_event(event) -> dict | None:
    """Strands のストリーミングイベントをフロントエンド向けの形式に変換する"""
    try:
        if not hasattr(event, "get"):
            return None
        inner_event = event.get("event")
        if not inner_event:
            return None

        # テキストデルタイベント
        content_block_delta = inner_event.get("contentBlockDelta")
        if content_block_delta:
            delta = content_block_delta.get("delta", {})
            text = delta.get("text")
            if text:
                return {"type": "text", "data": text}

        # ツール使用開始イベント
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
    """AgentCore Runtime のエントリポイント（ストリーミング対応）"""
    prompt = payload.get("prompt", "")

    agent = Agent(
        model="us.anthropic.claude-haiku-4-5-20251001-v1:0",
        system_prompt=(
            "あなたは親切で有能なAIアシスタントです。"
            "日本語で丁寧に回答してください。"
            "質問に対して分かりやすく、具体的な回答を心がけてください。"
        ),
    )

    async for event in agent.stream_async(prompt):
        converted = convert_event(event)
        if converted:
            yield converted


if __name__ == "__main__":
    app.run()
