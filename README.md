# 🤖 AI エージェントチャットアプリ（AgentCore + Amplify Gen2）

Amazon Bedrock AgentCore と AWS Amplify Gen2 を組み合わせた、**Web 検索機能付きフルスタック AI チャットアプリ**です。
Cognito 認証・ストリーミング応答・Tavily 外部検索ツール連携を実現しています。

---

## 📖 概要

このプロジェクトは以下の機能を持つ AI チャットアプリケーションです：

- 🔐 **メール/パスワード認証**（Amazon Cognito）
- 💬 **ストリーミング表示**（SSE）で AI の回答をリアルタイムに表示
- 🔍 **Tavily Web 検索ツール**を使って最新情報を調べて回答
- 📱 **レスポンシブ対応**のチャット UI
- ☁️ **GitHub push → 自動デプロイ**（Amplify CI/CD）

---

## 🏗️ アーキテクチャ構成図

![AWS アーキテクチャ構成図](docs/aws_architecture.png)

### リクエストフロー詳細

| ステップ | 処理内容 |
|:---:|---|
| 1 | ユーザーがブラウザでアプリにアクセス |
| 2-3 | Cognito でメール/パスワード認証 → JWT トークン発行 |
| 4 | React がフロントエンドから AgentCore Runtime に SSE で接続（Bearer JWT） |
| 5 | Runtime の Strands Agent が Secrets Manager から Gateway URL・スコープを取得 |
| 6 | `@requires_access_token` が AgentCore Identity に M2M トークンを自動取得（Cognito client_credentials） |
| 7 | MCP クライアントで AgentCore Gateway に接続、Tavily ツールを取得 |
| 8 | Strands Agent が Claude Haiku でユーザーの質問を処理 |
| 9 | 検索が必要な場合、Gateway 経由で Tavily API を呼び出し（Identity が API キー注入） |

---

## 🛠️ 使用技術

### フロントエンド
| 技術 | バージョン | 役割 |
|---|---|---|
| React | 18.3 | UI フレームワーク |
| Vite | 7.3 | ビルドツール |
| TypeScript | 5.9 | 型安全な開発 |
| AWS Amplify UI | 6.13 | 認証 UI コンポーネント |
| react-markdown | 9.0 | AI 応答の Markdown レンダリング |

### バックエンド（AWS CDK / Amplify Gen2）
| 技術 | 役割 |
|---|---|
| AWS Amplify Gen2 | インフラ定義・自動デプロイ |
| Amazon Cognito | ユーザー認証・M2M OAuth2 |
| AgentCore Runtime | エージェント実行環境（Docker コンテナ）|
| AgentCore Gateway | 外部 API の MCP プロトコル変換 |
| AgentCore Identity | 外部 API キーの安全な管理 |
| Amazon ECR | Docker イメージのホスティング |
| AWS Secrets Manager | 接続情報・API キーの保存 |

### エージェント（Python）
| ライブラリ | 役割 |
|---|---|
| `strands-agents` | マルチステップ AI エージェントフレームワーク |
| `bedrock-agentcore` | AgentCore Runtime / Identity との統合 |
| `mcp` | MCP プロトコルクライアント |

### AI モデル
| モデル | 用途 |
|---|---|
| `us.anthropic.claude-haiku-4-5-20251001-v1:0` | チャット応答の生成 |

---

## 📁 ディレクトリ構成

```
agentcore-cdk/
├── amplify/                        # Amplify Gen2 バックエンド定義
│   ├── backend.ts                  # バックエンドのエントリポイント
│   ├── auth/
│   │   └── resource.ts             # Cognito 認証設定（メール認証）
│   └── agent/
│       ├── resource.ts             # CDK TypeScript（Runtime + Gateway + Identity）
│       ├── app.py                  # Strands Agent エントリポイント
│       ├── requirements.txt        # Python 依存パッケージ
│       ├── Dockerfile              # ARM64 対応 Docker イメージ
│       └── .dockerignore           # Docker ビルド除外ファイル
├── src/                            # React フロントエンド
│   ├── main.tsx                    # アプリエントリ（Authenticator でラップ）
│   ├── App.tsx                     # チャット UI + SSE ストリーミング
│   ├── index.css                   # チャット UI スタイル
│   └── App.css                     # 追加スタイル
├── amplify.yml                     # Amplify CI/CD ビルド設定
├── package.json                    # Node.js 依存パッケージ
└── vite.config.ts                  # Vite 設定
```

---

## ✅ 前提条件

| ツール | バージョン | 確認コマンド |
|---|---|---|
| Node.js | >= 20.20.0 | `node --version` |
| npm | >= 10.8.0 | `npm --version` |
| AWS CLI | v2 | `aws --version` |
| AWS アカウント | - | us-west-2 リージョンへのアクセス権 |
| GitHub アカウント | - | リポジトリの fork/clone 用 |

### 必要な AWS 権限
- Amazon Bedrock（Claude Haiku モデルへのアクセス）
- Amazon Cognito
- AgentCore Runtime / Gateway / Identity
- Amazon ECR
- AWS Secrets Manager
- AWS Lambda
- AWS IAM

> ⚠️ **Bedrock モデルアクセス**: us-west-2 リージョンで `anthropic.claude-haiku-4-5-20251001-v1:0` のモデルアクセスを有効化してください。
> [Amazon Bedrock コンソール](https://us-west-2.console.aws.amazon.com/bedrock/home?region=us-west-2#/modelaccess) → 「モデルアクセス」→ Claude Haiku を有効化

---

## 🚀 セットアップ手順

### 1. リポジトリのフォーク・クローン

```bash
# GitHub でリポジトリをフォーク後、クローン
git clone https://github.com/<あなたのユーザー名>/agentcore-cdk.git
cd agentcore-cdk
```

### 2. 依存パッケージのインストール

```bash
npm install
```

### 3. AWS 認証の設定

```bash
# AWS SSO ログイン（または通常の aws configure）
aws configure
# リージョンは us-west-2 を推奨
```

### 4. Amplify Gen2 と GitHub の接続（自動デプロイ設定）

1. [AWS Amplify コンソール](https://us-west-2.console.aws.amazon.com/amplify/home?region=us-west-2) にアクセス
2. 「新しいアプリを作成」→「Git プロバイダーを使用してデプロイ」
3. GitHub と接続してフォークしたリポジトリを選択
4. `main` ブランチを選択
5. ビルド設定は `amplify.yml` が自動検出されます
6. 「保存してデプロイ」をクリック

> 📌 初回デプロイには **10〜15 分程度**かかります（Docker イメージのビルドが含まれるため）

### 5. Tavily API キーの設定

API キーはコードに書かず、**Amplify Console の環境変数**として設定します：

1. [Tavily](https://tavily.com/) でアカウントを作成して API キーを取得
2. [AWS Amplify コンソール](https://us-west-2.console.aws.amazon.com/amplify/) → アプリ → 「環境変数」
3. 以下を追加して保存：
   - **変数名**: `TAVILY_API_KEY`
   - **値**: `tvly-xxxxxxxxxxxxxxxxxx`（取得した API キー）
4. 再デプロイをトリガー（コミット push 等）

> ⚠️ `TAVILY_API_KEY` が未設定のままデプロイすると CDK synthesis 時にエラーで止まります（意図的なガード）。

---

## 🔄 デプロイの仕組み

```
git push → GitHub → Amplify Console
                         ↓
                    amplify.yml に基づいてビルド
                         ↓
                    CDK で AWS リソースを自動作成
                    ・Cognito User Pool
                    ・AgentCore Runtime（ECRへDockerビルド＆プッシュ）
                    ・AgentCore Gateway + Identity
                    ・Secrets Manager シークレット
                         ↓
                    React アプリをビルド＆ホスティング
                         ↓
                    amplify_outputs.json に Runtime ARN を出力
                         ↓
                    デプロイ完了 → Amplify の URL でアクセス可能
```

---

## 🧪 動作確認

1. Amplify コンソールからデプロイ済みの URL にアクセス
2. 「アカウントを作成」でメールアドレスとパスワードを入力してサインアップ
3. 確認コードをメールで受け取り、入力してサインイン
4. チャット欄にメッセージを入力して送信：

**通常の質問**
```
こんにちは！自己紹介してください
```

**Web 検索が必要な質問**（Tavily 検索ツールが使われます）
```
最新のAWS Bedrockのニュースを教えてください
```
```
今日の東京の天気はどうですか？
```

> 🔧 Web 検索が実行されると、メッセージ欄に「`tavily-search___searchWeb` を実行中...」と表示されます

---

## ⚙️ ローカル開発

フロントエンドのみローカルで動作確認する場合：

```bash
# 1. Amplify の sandbox 環境を起動（AWS リソースを一時デプロイ）
npx ampx sandbox

# 2. 別ターミナルで React の開発サーバーを起動
npm run dev
```

> ⚠️ `ampx sandbox` は AgentCore Runtime・Gateway など全 AWS リソースをデプロイするため、
> 起動に 10〜15 分かかります。終了時は `Ctrl+C` → リソース削除の確認で `y`

---

## 🔧 よくあるトラブルと対処法

### ❌ デプロイが失敗する（`Name cannot be updated for an existing gateway`）

**原因**: AgentCore Gateway は CloudFormation のインプレース更新非対応です。Gateway に依存するリソース（ResourceServer・M2MClient）の変更が Gateway の UPDATE を引き起こすと失敗します。

**根本的な対処法**: 変更が連鎖して Gateway を UPDATE しないよう、変更を受けるリソースのロジカル ID を変更して **CREATE → DELETE** に切り替えます：

```typescript
// ResourceServer・M2MClient のロジカルIDを変更 → 旧リソースをDELETE、新リソースをCREATE
gatewayUserPool.addResourceServer("GatewayResourceServer2", { ... });  // 数字をインクリメント
gatewayUserPool.addClient("GatewayM2MClient2", { ... });               // 数字をインクリメント
new cr.AwsCustomResource(stack, "GetGatewayClientSecret2", { ... });   // 数字をインクリメント

// Gateway 自体のロジカルIDと名前も変更（強制 CREATE で旧 Gateway を DELETE）
const gateway = new agentcore.Gateway(stack, "AgentGateway4", {
  gatewayName: `agent-gw4-${envId}`,
  ...
});
```

**重要**: `cognitoDomainPrefix` の変更は Cognito ドメインの更新エラーになるため、`appId` は `stackNameParts[1]`（固定値 `"app"`）を使い、`process.env.AWS_APP_ID` は使用しないこと。

---

### ❌ Web 検索が古い情報を返す（2024年などの過去の情報）

**原因**: Claude のトレーニングカットオフが2024年頃のため、「最新」＝2024年と認識して検索クエリに古い年を使用してしまいます。

**対処**: システムプロンプトに現在の日付を動的に注入します（`app.py` で実装済み）：

```python
from datetime import datetime
today = datetime.now().strftime("%Y年%m月%d日")
system_prompt = f"現在の日付は {today} です。..."  # → "現在の日付は 2026年03月02日 です。"
```

---

### ❌ `GetResourceOauth2Token` で 403 AccessDeniedException

**エラーログ例**:
```
AccessDeniedException: You are not authorized to perform: secretsmanager:GetSecretValue
```

**原因**: `create_oauth2_credential_provider` が `clientSecret` を Secrets Manager に別途保存する。`GetResourceOauth2Token` はその `clientSecretArn` を Runtime の IAM ロールで読みに行くが、権限がなかった。

**対処済み**: Runtime の IAM ポリシーにアカウント/リージョン内の全 Secrets Manager 読み取りを許可（`secret:*`）。Identity が作成するシークレット ARN は CDK synthesis 時に確定しないため固定パターンで対処。

---

### ❌ IAM ポリシーで「Syntax errors in policy」エラー

**エラーログ例**:
```
Resource handler returned message: "Syntax errors in policy. (Service: Iam, Status Code: 400)"
```

**原因**: `Custom Resource` の出力値（`Fn::GetAtt`）を IAM ポリシーの `resources` に使用すると、Custom Resource が未実行の場合に空文字列が渡り構文エラーになる。

**対処済み**: `getAttString("ClientSecretArn")` の参照をやめ、アカウント/リージョン範囲のワイルドカード `secret:*` に置き換え。

---

### ❌ チャットで「検索に一時的なエラーが発生しました」が返る

**原因**: Gateway の IAM 権限が不足している可能性があります。

**確認方法**:
```bash
# Gateway に DEBUG モードを設定してエラー詳細を確認
aws bedrock-agentcore-control update-gateway \
  --gateway-identifier "<your-gateway-id>" \
  --name "<gateway-name>" \
  --role-arn "<role-arn>" \
  --protocol-type "MCP" \
  --protocol-configuration '{"mcp": {"supportedVersions": ["2025-03-26"]}}' \
  --authorizer-type "CUSTOM_JWT" \
  --authorizer-configuration '{"customJWTAuthorizer": {"discoveryUrl": "...", "allowedClients": ["..."]}}' \
  --exception-level "DEBUG" \
  --region us-west-2
```

---

### ❌ `amplify_outputs.json が見つかりません` エラー

**原因**: Amplify のバックエンドデプロイが完了していません。

**対処**: Amplify コンソールでデプロイが `SUCCEED` になるのを待ち、再度アクセスしてください。

---

### ❌ Docker ビルドが毎回走って遅い

**原因**: `amplify/agent/.dockerignore` が正しく設定されていない可能性があります。

**確認**: 以下のファイルが存在するか確認：

```
amplify/agent/.dockerignore
```

内容：
```
*.ts
*.js
node_modules/
__pycache__/
*.pyc
.env
```

---

## 📝 主要ファイルの説明

### [amplify/agent/resource.ts](amplify/agent/resource.ts)
CDK TypeScript で以下の AWS リソースを定義：
- **AgentCore Runtime**: Strands Agent を実行する Docker コンテナ環境
- **AgentCore Gateway**: Tavily API を MCP ツールとして提供するゲートウェイ
- **AgentCore Identity（API キープロバイダー）**: Tavily API キーを安全に管理（CDK L2 非対応のため Lambda Custom Resource で作成）
- **AgentCore Identity（OAuth2 プロバイダー）**: Gateway M2M 認証情報を管理。`@requires_access_token` デコレータが自動参照（Lambda Custom Resource で `create_oauth2_credential_provider` を呼び出し）
- **Cognito M2M**: Gateway へのアクセス認証用 OAuth2 クライアント（client_credentials フロー）
- **Secrets Manager `agentcore-gateway-config`**: Gateway URL・スコープを保存（認証情報は Identity に移管済み）

### [amplify/agent/app.py](amplify/agent/app.py)
Strands Agent の Python 実装
```python
@app.entrypoint
async def invoke_agent(payload, context):
    # 1. Secrets Manager から Gateway URL・スコープを取得
    # 2. @requires_access_token を entrypoint 内で定義（動的 provider_name / scopes 対応）
    @requires_access_token(
        provider_name="gateway-m2m-oauth",  # Identity に登録した OAuth2 プロバイダー名
        scopes=scopes.split(),              # e.g. ["gateway-main/invoke"]
        auth_flow="M2M",                    # client_credentials フロー（ユーザー操作不要）
    )
    async def _get_gateway_token(*, access_token: str) -> str:
        return access_token  # Identity が Cognito M2M フローを自動実行してトークンを注入

    # 3. Identity から M2M トークンを取得
    token = await _get_gateway_token()
    # 4. MCP クライアントで Gateway に接続
    # 5. list_tools_sync() 後に手動フィルタで tavily-search___searchWeb のみ許可
    # 6. 現在日付をシステムプロンプトに注入（モデルの知識カットオフ対策）
    # 7. Strands Agent で Claude Haiku + Tavily ツールをストリーミング実行
```

**ポイント**:
- `@requires_access_token` は `@app.entrypoint` **内部**で定義すること（参考コードのパターン）。モジュールレベルでは `provider_name` / `scopes` を動的に設定できない
- `tool_filters` パラメータはプレフィックス付与前のRAW名でマッチするため機能しない。`list_tools_sync()` 後に `tool_name` 属性で手動フィルタする
- `datetime.now()` で取得した現在日付をシステムプロンプトに含めることで、LLM のトレーニングカットオフによる古い年の検索クエリ生成を防ぐ

### [src/App.tsx](src/App.tsx)
React チャット UI の実装：
- Cognito JWT トークンを取得して AgentCore Runtime に送信
- SSE（Server-Sent Events）でストリーミングレスポンスを処理
- react-markdown で AI の応答を Markdown レンダリング

---

## 💰 コスト概算

| サービス | 費用の目安 |
|---|---|
| AgentCore Runtime | リクエスト数に応じた従量課金 |
| AgentCore Gateway | リクエスト数に応じた従量課金 |
| Amazon Bedrock (Claude Haiku) | 入力 $0.80 / 100万トークン、出力 $4.00 / 100万トークン |
| Amplify Hosting | 無料枠あり（月 5GB まで無料） |
| Amazon Cognito | 月 50,000 MAU まで無料 |
| Secrets Manager | シークレット 1 件 $0.40/月 |

> ⚠️ 開発・検証目的での利用を想定しています。大規模な本番運用の際はコスト設計をお願いします。

---

## 🔒 セキュリティ

- **Tavily API キー**: コードに書かず Amplify Console の環境変数 `TAVILY_API_KEY` で管理。GitHubパブリックリポジトリに漏れない
- **Cognito 認証**: 認証されたユーザーのみが AgentCore Runtime にアクセスできます
- **Runtime → Gateway 間**: `@requires_access_token` + AgentCore Identity (OAuth2 M2M) で自動的に保護
- **Gateway → Tavily 間**: API キーは AgentCore Identity（API キープロバイダー）で安全に管理。コードに直接現れない
- **OAuth2 clientSecret**: Identity が Secrets Manager に保存・管理。Runtime は `GetResourceOauth2Token` 経由で間接的に使用

セキュリティ上の問題を発見した場合は [CONTRIBUTING.md](CONTRIBUTING.md) をご確認ください。

---

## 📚 参考リンク

- [Amazon Bedrock AgentCore ドキュメント](https://docs.aws.amazon.com/bedrock-agentcore/)
- [AWS Amplify Gen2 ドキュメント](https://docs.amplify.aws/gen2/)
- [Strands Agents ドキュメント](https://strandsagents.com/docs/)
- [Tavily API ドキュメント](https://docs.tavily.com/)

---

## 📄 ライセンス

MIT-0 ライセンス。詳細は [LICENSE](LICENSE) ファイルを参照してください。
