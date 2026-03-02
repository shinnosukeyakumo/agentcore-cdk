import { Stack, Duration, Fn, CustomResource } from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "@aws-cdk/aws-bedrock-agentcore-alpha";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sm from "aws-cdk-lib/aws-secretsmanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { ContainerImageBuild } from "@cdklabs/deploy-time-build";
import { IUserPool, IUserPoolClient } from "aws-cdk-lib/aws-cognito";
import * as path from "path";
import { fileURLToPath } from "url";

// Tavily APIキー（Amplify Console の環境変数 TAVILY_API_KEY から読み込む）
// ※ コードにAPIキーをハードコートしないこと（GitHubパブリックリポジトリ対応）
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";
if (!TAVILY_API_KEY) {
  throw new Error(
    "環境変数 TAVILY_API_KEY が未設定です。" +
      "Amplify Console の環境変数に TAVILY_API_KEY を設定してください。"
  );
}

// Tavily Search API の OpenAPI スキーマ
// Gateway がこのスキーマを元に LLM に検索ツールとして提供する
const TAVILY_OPENAPI_SCHEMA = JSON.stringify({
  openapi: "3.0.0",
  info: {
    title: "Tavily Search API",
    version: "1.0.0",
    description: "Search the internet for up-to-date information using Tavily",
  },
  servers: [{ url: "https://api.tavily.com" }],
  paths: {
    "/search": {
      post: {
        operationId: "searchWeb",
        summary: "Search the web for current information",
        description:
          "Use this tool to search the internet for up-to-date information on any topic",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["query"],
                properties: {
                  query: {
                    type: "string",
                    description: "The search query to look up on the internet",
                  },
                  max_results: {
                    type: "integer",
                    default: 3,
                    description: "Maximum number of search results to return",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Search results",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          title: { type: "string" },
                          url: { type: "string" },
                          content: { type: "string" },
                          score: { type: "number" },
                        },
                      },
                    },
                    answer: {
                      type: "string",
                      description: "AI-generated answer based on search results",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

// AgentCore Identity 認証プロバイダーを作成するLambdaのコード
// cr.Provider フレームワーク用なので cfnresponse.send() は使わず return dict にする
// apiKeySecretArn は文字列または {secretArn: "..."} 形式の両方に対応
const IDENTITY_PROVIDER_LAMBDA_CODE = `
import boto3
import json

def handler(event, context):
    client = boto3.client("bedrock-agentcore-control", region_name="us-west-2")
    props = event["ResourceProperties"]
    provider_name = props["ProviderName"]
    api_key = props["ApiKey"]

    if event["RequestType"] in ["Create", "Update"]:
        try:
            resp = client.create_api_key_credential_provider(
                name=provider_name,
                apiKey=api_key,
            )
            arn = resp["credentialProviderArn"]
        except Exception as e:
            err_msg = str(e)
            if ("already exists" in err_msg.lower()
                    or "conflict" in err_msg.lower()
                    or "ConflictException" in err_msg):
                resp = client.get_api_key_credential_provider(name=provider_name)
                arn = resp["credentialProviderArn"]
            else:
                raise Exception(f"Failed to create credential provider: {err_msg}")

        # Identityが内部で作成したSecretsManagerのシークレットARNを取得する
        get_resp = client.get_api_key_credential_provider(name=provider_name)

        # デバッグ: レスポンス構造を記録
        print(f"DEBUG response keys: {list(get_resp.keys())}")
        print(f"DEBUG apiKeySecretArn raw: {get_resp.get('apiKeySecretArn')}")

        # apiKeySecretArn はAPIバージョンにより文字列またはdict形式の場合がある
        api_key_secret_arn_raw = get_resp.get("apiKeySecretArn", None)
        if api_key_secret_arn_raw is None:
            api_key_secret_arn = ""
        elif isinstance(api_key_secret_arn_raw, dict):
            api_key_secret_arn = api_key_secret_arn_raw.get("secretArn", "")
        else:
            api_key_secret_arn = str(api_key_secret_arn_raw)

        print(f"DEBUG api_key_secret_arn resolved: {api_key_secret_arn}")

        return {
            "PhysicalResourceId": provider_name,
            "Data": {
                "CredentialProviderArn": arn,
                "ApiKeySecretArn": api_key_secret_arn,
            },
        }

    elif event["RequestType"] == "Delete":
        try:
            client.delete_api_key_credential_provider(name=provider_name)
        except Exception:
            pass
        return {"PhysicalResourceId": provider_name}
`;

// Gateway M2M OAuth2 認証プロバイダーを Identity に登録するLambdaのコード
// @requires_access_token デコレータが M2M トークンを自動取得できるよう
// Cognito M2M クライアント情報を AgentCore Identity（CustomOauth2）として登録する
const OAUTH_PROVIDER_LAMBDA_CODE = `
import boto3
import json

def handler(event, context):
    client = boto3.client("bedrock-agentcore-control", region_name="us-west-2")
    props = event["ResourceProperties"]
    provider_name = props["ProviderName"]
    user_pool_id = props["UserPoolId"]
    client_id = props["ClientId"]
    client_secret = props["ClientSecret"]
    region = props.get("Region", "us-west-2")

    if event["RequestType"] in ["Create", "Update"]:
        discovery_url = (
            f"https://cognito-idp.{region}.amazonaws.com"
            f"/{user_pool_id}/.well-known/openid-configuration"
        )
        try:
            resp = client.create_oauth2_credential_provider(
                credentialProviderVendor="CustomOauth2",
                name=provider_name,
                oauth2ProviderConfigInput={
                    "customOauth2ProviderConfig": {
                        "oauthDiscovery": {
                            "discoveryUrl": discovery_url
                        },
                        "clientId": client_id,
                        "clientSecret": client_secret,
                    }
                }
            )
            arn = resp["credentialProviderArn"]
        except Exception as e:
            err_msg = str(e)
            if ("already exists" in err_msg.lower()
                    or "conflict" in err_msg.lower()
                    or "ConflictException" in err_msg):
                resp = client.get_oauth2_credential_provider(name=provider_name)
                arn = resp["credentialProviderArn"]
            else:
                raise Exception(f"Failed to create OAuth2 credential provider: {err_msg}")

        return {
            "PhysicalResourceId": provider_name,
            "Data": {
                "CredentialProviderArn": arn,
            },
        }

    elif event["RequestType"] == "Delete":
        try:
            client.delete_oauth2_credential_provider(name=provider_name)
        except Exception:
            pass
        return {"PhysicalResourceId": provider_name}
`;

export function createAgentCoreRuntime(
  stack: Stack,
  userPool: IUserPool,
  userPoolClient: IUserPoolClient
) {
  // amplify/agent/ ディレクトリの Dockerfile からコンテナイメージをビルドして ECR へプッシュ
  const agentImage = new ContainerImageBuild(stack, "AgentImage", {
    directory: path.dirname(fileURLToPath(import.meta.url)),
    platform: Platform.LINUX_ARM64,
  });

  // ===== 安定した環境ID の生成 =====
  // stack.stackName の構造: "<prefix>-<appId>-<suffix>-..."
  // stackNameParts[1] = "app" → 常に固定値（Amplify デプロイ間で変わらない）
  // AWS_APP_ID は使用しない（"d3nt7aujsrzeps" 等の実際のIDに変わると
  // cognitoDomainPrefix が変わり Cognito ドメイン更新エラーになるため）
  //
  // AWS_BRANCH は安定した環境ID として使用可能（"main" 等、ブランチ名は変わらない）
  const stackNameParts = stack.stackName.split("-");
  const appId = stackNameParts.length >= 2 ? stackNameParts[1] : "app";
  const envId = (process.env.AWS_BRANCH || "main")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .substring(0, 10);

  // Cognito ドメインプレフィックス（グローバル一意）: "agentgwapp"（固定）
  // appId = "app" なので cognitoDomainPrefix = "agentgwapp" で安定
  const cognitoDomainPrefix = `agentgw${appId.substring(0, 12)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .substring(0, 30);

  // ===== AgentCore Runtime（L2コンストラクト） =====
  const runtime = new agentcore.Runtime(stack, "ChatAgentRuntime", {
    runtimeName: `chat_agent_${envId}`,
    agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(
      agentImage.repository,
      agentImage.imageTag
    ),
    // Cognito JWT 認証（フロントエンドからのJWTトークンを検証）
    authorizerConfiguration:
      agentcore.RuntimeAuthorizerConfiguration.usingCognito(userPool, [
        userPoolClient,
      ]),
    networkConfiguration:
      agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
  });

  // Bedrock モデル呼び出し権限を付与
  runtime.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:*:inference-profile/*",
      ],
    })
  );

  // ===== AgentCore Identity 認証プロバイダーを作成（Lambda Custom Resource） =====
  // CDK L2 では Identity プロバイダーの直接作成をサポートしていないため
  // Lambda Custom Resource を使って boto3 API を呼び出す
  const identityFn = new lambda.Function(stack, "IdentityProviderFn", {
    runtime: lambda.Runtime.PYTHON_3_12,
    handler: "index.handler",
    timeout: Duration.minutes(5),
    code: lambda.Code.fromInline(IDENTITY_PROVIDER_LAMBDA_CODE),
  });

  // bedrock-agentcore コントロールプレーンの操作を許可
  identityFn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["bedrock-agentcore:*"],
      resources: ["*"],
    })
  );
  // create_api_key_credential_provider は内部的に Secrets Manager にAPIキーを保存するため
  // secretsmanager の権限も必要
  identityFn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "secretsmanager:CreateSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:GetSecretValue",
        "secretsmanager:DeleteSecret",
        "secretsmanager:TagResource",
        "secretsmanager:DescribeSecret",
      ],
      resources: ["*"],
    })
  );

  // Identity 認証プロバイダーを作成
  const identityProvider = new CustomResource(stack, "TavilyIdentityProvider", {
    serviceToken: new cr.Provider(stack, "IdentityProviderCrProvider", {
      onEventHandler: identityFn,
    }).serviceToken,
    properties: {
      ProviderName: "tavily-search",
      ApiKey: TAVILY_API_KEY,
      // Version を更新することで Lambda Custom Resource を強制再実行し
      // apiKeySecretArn のデバッグ出力を確認する
      Version: "4",
    },
  });

  const identityProviderArn =
    identityProvider.getAttString("CredentialProviderArn");
  // Identity が内部で作成したシークレットのARN（IAM権限設定に使用）
  const identityApiKeySecretArn =
    identityProvider.getAttString("ApiKeySecretArn");

  // ===== Gateway用 カスタム Cognito User Pool =====
  // 自動生成 Cognito の代わりに独自 UserPool を使用することで:
  // - スコープ名が安定（再デプロイしても変わらない）
  // - client_credentials フローが確実に有効化される
  const gatewayUserPool = new cognito.UserPool(stack, "GatewayUserPool", {
    userPoolName: `gateway-user-pool-${envId}`,
    selfSignUpEnabled: false,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  // リソースサーバーにスコープを定義
  const invokeScope = new cognito.ResourceServerScope({
    scopeName: "invoke",
    scopeDescription: "Invoke AgentCore Gateway",
  });

  // リソースサーバーID（envIdベースで予測可能な名前）
  const resourceServerId = `gateway-${envId}`;
  // ロジカルIDを "GatewayResourceServer2" に変更することで、
  // 旧リソース（identifier: "gateway-oken149"）を DELETE し
  // 新リソース（identifier: "gateway-main"）を CREATE する。
  // → 同一ロジカルIDのまま identifier を変えると CloudFormation が
  //   インプレース REPLACE を試みて M2MClient UPDATE → Gateway UPDATE → FAIL になる。
  const resourceServer = gatewayUserPool.addResourceServer(
    "GatewayResourceServer2",
    {
      identifier: resourceServerId,
      scopes: [invokeScope],
    }
  );

  // Cognito ドメインを追加（トークンエンドポイント用）
  // cognitoDomainPrefix を使って tokenEndpoint URL を構築するためドメイン自体が必要
  gatewayUserPool.addDomain("GatewayUserPoolDomain", {
    cognitoDomain: {
      domainPrefix: cognitoDomainPrefix,
    },
  });

  // ロジカルIDを "GatewayM2MClient2" に変更することで、
  // ResourceServer2 の新スコープ（"gateway-main/invoke"）を持つ新規クライアントを CREATE し
  // 旧クライアントを DELETE する（スコープ URL の変更を安全に移行）。
  const m2mClient = gatewayUserPool.addClient("GatewayM2MClient2", {
    userPoolClientName: `gateway-m2m-${envId}`,
    generateSecret: true,
    oAuth: {
      flows: { clientCredentials: true },
      scopes: [cognito.OAuthScope.resourceServer(resourceServer, invokeScope)],
    },
  });

  // ===== AgentCore Gateway（L2コンストラクト） =====
  // Gateway名はハイフン区切りのみ許可（アンダースコア不可）
  // ※ Gateway は CloudFormation によるインプレース UPDATE が不可のため、
  //    設定変更時はロジカルIDと名前を変更して強制 CREATE（古いものは DELETE）する。
  const gateway = new agentcore.Gateway(stack, "AgentGateway4", {
    gatewayName: `agent-gw4-${envId}`,
    protocolConfiguration: agentcore.GatewayProtocol.mcp({
      supportedVersions: [agentcore.MCPProtocolVersion.MCP_2025_03_26],
    }),
    // 独自 Cognito を使用: スコープが安定、client_credentials が確実に有効
    authorizerConfiguration: agentcore.GatewayAuthorizer.usingCognito({
      userPool: gatewayUserPool,
      allowedClients: [m2mClient],
    }),
  });

  // Tavily検索APIをGatewayのOpenAPIターゲットとして追加
  // Identity に登録されたAPIキーが自動的に Authorization: Bearer ヘッダーに注入される
  gateway.addOpenApiTarget("TavilySearch", {
    gatewayTargetName: "tavily-search",
    apiSchema: agentcore.ApiSchema.fromInline(TAVILY_OPENAPI_SCHEMA),
    credentialProviderConfigurations: [
      agentcore.GatewayCredentialProvider.fromApiKeyIdentityArn({
        providerArn: identityProviderArn,
        // Identity が内部で作成したシークレットARN（IAM権限付与に使用）
        secretArn: identityApiKeySecretArn,
        // デフォルト: Authorization: Bearer <api_key>
        credentialLocation: agentcore.ApiKeyCredentialLocation.header({
          credentialParameterName: "Authorization",
          credentialPrefix: "Bearer ",
        }),
      }),
    ],
  });

  // CDK L2 の fromApiKeyIdentityArn は Grant フラッティングバグにより
  // GetWorkloadAccessToken / GetResourceApiKey を誤ったリソース ARN に設定する。
  // gateway.role.addToPrincipalPolicy() を使うと DefaultPolicy が更新され、
  // CloudFormation が Gateway の UPDATE を試みて "Name cannot be updated" エラーになる。
  // 回避策: CfnRolePolicy (L1) を使って別リソースとして追加する。
  // → Gateway の DependsOn チェーンに入らないため、Gateway UPDATE は発生しない。
  new iam.CfnRolePolicy(stack, "GatewayWorkloadPolicy4", {
    roleName: (gateway.role as iam.IRole).roleName,
    policyName: "WorkloadIdentityAccess",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "bedrock-agentcore:GetWorkloadAccessToken",
            "bedrock-agentcore:GetResourceApiKey",
          ],
          Resource: "*",
        },
      ],
    },
  });

  // ===== Gateway M2M認証情報を取得 =====
  // カスタム Cognito クライアントのシークレットを取得する
  // ロジカルIDを "GetGatewayClientSecret2" に変更して GatewayM2MClient2 のシークレットを取得
  const getClientSecretCR = new cr.AwsCustomResource(
    stack,
    "GetGatewayClientSecret2",
    {
      onUpdate: {
        service: "CognitoIdentityServiceProvider",
        action: "describeUserPoolClient",
        parameters: {
          UserPoolId: gatewayUserPool.userPoolId,
          ClientId: m2mClient.userPoolClientId,
        },
        physicalResourceId: cr.PhysicalResourceId.of("GetGatewayClientSecret2"),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    }
  );

  // Gatewayリソースが作成された後に実行するよう依存関係を設定
  getClientSecretCR.node.addDependency(gateway);

  const gatewayClientSecret = getClientSecretCR.getResponseField(
    "UserPoolClient.ClientSecret"
  );

  // スコープ文字列（{resourceServerId}/invoke 形式）
  const gatewayScope = `${resourceServerId}/invoke`;

  // ===== Gateway M2M OAuth2 クレデンシャルプロバイダーを Identity に登録 =====
  // @requires_access_token デコレータが Identity 経由で M2M トークンを自動取得できるよう
  // Cognito M2M クライアントの情報を AgentCore Identity（CustomOauth2）として登録する
  const oauthProviderFn = new lambda.Function(stack, "OAuthProviderFn", {
    runtime: lambda.Runtime.PYTHON_3_12,
    handler: "index.handler",
    timeout: Duration.minutes(5),
    code: lambda.Code.fromInline(OAUTH_PROVIDER_LAMBDA_CODE),
  });

  oauthProviderFn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["bedrock-agentcore:*"],
      resources: ["*"],
    })
  );
  oauthProviderFn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "secretsmanager:CreateSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:GetSecretValue",
        "secretsmanager:DeleteSecret",
        "secretsmanager:TagResource",
        "secretsmanager:DescribeSecret",
      ],
      resources: ["*"],
    })
  );

  const gatewayOAuth2ProviderCR = new CustomResource(
    stack,
    "GatewayOAuth2Provider",
    {
      serviceToken: new cr.Provider(stack, "OAuthProviderCrProvider", {
        onEventHandler: oauthProviderFn,
      }).serviceToken,
      properties: {
        ProviderName: "gateway-m2m-oauth",
        UserPoolId: gatewayUserPool.userPoolId,
        ClientId: m2mClient.userPoolClientId,
        // getClientSecretCR が取得した Cognito M2M クライアントシークレット
        ClientSecret: gatewayClientSecret,
        Region: stack.region,
        Version: "1",
      },
    }
  );

  // getClientSecretCR が完了してから実行されるよう依存関係を設定
  gatewayOAuth2ProviderCR.node.addDependency(getClientSecretCR);

  // ===== Gateway 接続設定を Secrets Manager に保存 =====
  // M2M 認証情報（clientId/clientSecret）は AgentCore Identity に登録済みのため不要
  // Runtime エージェントはこのシークレットから gatewayUrl と scopes のみ読み込む
  const gatewayConfigSecret = new sm.CfnSecret(stack, "GatewayConfig", {
    name: "agentcore-gateway-config",
    description: "AgentCore Gateway endpoint config for Runtime agent",
    secretString: Fn.toJsonString({
      gatewayUrl: gateway.gatewayUrl,
      scopes: gatewayScope,
    }),
  });

  // OAuth2 プロバイダーが登録された後にシークレットを作成
  gatewayConfigSecret.node.addDependency(gatewayOAuth2ProviderCR);

  // ===== RuntimeのIAMロールにSecrets Manager読み取り権限を付与 =====
  runtime.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [
        // agentcore-gateway-config シークレット
        Fn.join("", [
          "arn:aws:secretsmanager:",
          stack.region,
          ":",
          stack.account,
          ":secret:agentcore-gateway-config*",
        ]),
      ],
    })
  );

  // ===== RuntimeのIAMロールにAgentCore Identity API呼び出し権限を付与 =====
  // @requires_access_token デコレータが内部で呼び出す API:
  //   GetWorkloadAccessToken: ワークロードの認証トークンを取得
  //   GetResourceOauth2Token: OAuth2 クレデンシャルプロバイダーからM2Mトークンを取得
  runtime.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:GetWorkloadAccessToken",
        "bedrock-agentcore:GetResourceOauth2Token",
      ],
      resources: ["*"],
    })
  );

  return { runtime, gateway };
}
