import { useState, useRef, useEffect } from "react";
import { fetchAuthSession, signOut } from "aws-amplify/auth";
import type { AuthUser } from "aws-amplify/auth";
import ReactMarkdown from "react-markdown";
import outputs from "../amplify_outputs.json";

// amplify_outputs.json の custom フィールドから AgentCore Runtime ARN を取得
const AGENT_ARN = (outputs as { custom?: { agentRuntimeArn?: string } }).custom
  ?.agentRuntimeArn;

type MessageRole = "user" | "assistant";

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  toolName?: string; // ツール使用中の表示用
}

interface AppProps {
  signOut?: () => void;
  user?: AuthUser;
}

function App({ user }: AppProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async () => {
    const userMessage = input.trim();
    if (!userMessage || isLoading) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: userMessage,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    const assistantMsgId = (Date.now() + 1).toString();
    setMessages((prev) => [
      ...prev,
      { id: assistantMsgId, role: "assistant", content: "" },
    ]);

    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.accessToken?.toString();
      if (!token) throw new Error("認証トークンを取得できませんでした");

      if (!AGENT_ARN) {
        throw new Error(
          "agentRuntimeArn が amplify_outputs.json に見つかりません。デプロイを確認してください。"
        );
      }

      const endpoint = `https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/${encodeURIComponent(AGENT_ARN)}/invocations?qualifier=DEFAULT`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ prompt: userMessage }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`APIエラー (${response.status}): ${errText}`);
      }

      // SSE ストリーミングレスポンスを逐次処理
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;

          try {
            const parsed = JSON.parse(data);

            if (parsed.type === "text" && parsed.data) {
              // テキストを逐次追加（ストリーミング表示）
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMsgId
                    ? { ...msg, content: msg.content + parsed.data }
                    : msg
                )
              );
            } else if (parsed.type === "tool_use" && parsed.tool_name) {
              // ツール使用中を表示
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMsgId
                    ? { ...msg, toolName: parsed.tool_name }
                    : msg
                )
              );
            }
          } catch {
            // パース失敗は無視
          }
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "エラーが発生しました";
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? { ...msg, content: `⚠️ ${errorMessage}` }
            : msg
        )
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="chat-container">
      <header className="chat-header">
        <h1>🤖 AI エージェント</h1>
        <div className="header-info">
          <span className="user-email">{user?.signInDetails?.loginId}</span>
          <button className="sign-out-btn" onClick={() => signOut()}>
            ログアウト
          </button>
        </div>
      </header>

      <div className="messages-area">
        {messages.length === 0 && (
          <div className="empty-state">
            <p>AIエージェントに話しかけてみましょう！</p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="message-label">
              {msg.role === "user" ? "あなた" : "AI"}
            </div>
            <div className="message-content">
              {msg.role === "assistant" ? (
                <>
                  {msg.toolName && !msg.content && (
                    <span className="tool-indicator">
                      🔧 {msg.toolName} を実行中...
                    </span>
                  )}
                  {msg.content ? (
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  ) : (
                    isLoading && (
                      <span className="thinking">考え中...</span>
                    )
                  )}
                </>
              ) : (
                msg.content
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-area">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="メッセージを入力... (Shift+Enter で改行、Enter で送信)"
          disabled={isLoading}
          rows={2}
        />
        <button onClick={sendMessage} disabled={isLoading || !input.trim()}>
          {isLoading ? "送信中..." : "送信"}
        </button>
      </div>
    </div>
  );
}

export default App;
