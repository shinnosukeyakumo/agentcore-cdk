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

// Tavily APIキー（AgentCore Identityに登録される）
const TAVILY_API_KEY = "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";

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

  // スタック名から環境IDを生成（例: "amplify-d3nt7aujsrzeps-main-branch-AgentCoreStack"）
  const stackNameParts = stack.stackName.split("-");
  // appId（Amplifyアプリ固有ID）: スタック名の2番目の要素（例: "d3nt7aujsrzeps"）
  const appId = stackNameParts.length >= 2 ? stackNameParts[1] : "app";
  const rawEnvId =
    stackNameParts.length >= 4
      ? stackNameParts[3]
      : stack.stackName.slice(-10);
  const envId = rawEnvId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

  // Cognito ドメインプレフィックス（グローバル一意）: アプリIDの先頭12文字を使用
  // 例: "agentgwd3nt7aujsrzep"（20文字）
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
  const resourceServer = gatewayUserPool.addResourceServer(
    "GatewayResourceServer",
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

  // M2M クライアント（client_credentials フロー）
  const m2mClient = gatewayUserPool.addClient("GatewayM2MClient", {
    userPoolClientName: `gateway-m2m-${envId}`,
    generateSecret: true,
    oAuth: {
      flows: { clientCredentials: true },
      scopes: [cognito.OAuthScope.resourceServer(resourceServer, invokeScope)],
    },
  });

  // ===== AgentCore Gateway（L2コンストラクト） =====
  // Gateway名はハイフン区切りのみ許可（アンダースコア不可）
  const gateway = new agentcore.Gateway(stack, "AgentGateway2", {
    gatewayName: `agent-gw-${envId}`,
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
  new iam.CfnRolePolicy(stack, "GatewayWorkloadPolicy", {
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
  const getClientSecretCR = new cr.AwsCustomResource(
    stack,
    "GetGatewayClientSecret",
    {
      onUpdate: {
        service: "CognitoIdentityServiceProvider",
        action: "describeUserPoolClient",
        parameters: {
          UserPoolId: gatewayUserPool.userPoolId,
          ClientId: m2mClient.userPoolClientId,
        },
        physicalResourceId: cr.PhysicalResourceId.of("GetGatewayClientSecret"),
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

  // トークンエンドポイントURL（カスタム Cognito ドメイン）
  // cognitoDomainPrefix は synthesis 時に確定する plain string なので直接使用可能
  const tokenEndpoint = Fn.join("", [
    "https://",
    cognitoDomainPrefix,
    ".auth.",
    stack.region,
    ".amazoncognito.com/oauth2/token",
  ]);

  // スコープ文字列（{resourceServerId}/invoke 形式）
  // これも synthesis 時に確定する plain string
  const gatewayScope = `${resourceServerId}/invoke`;

  // ===== Gateway M2M接続情報をまとめてSecrets Managerに保存 =====
  // Runtime上のエージェントがこのシークレットを読み込んでGatewayに接続する
  const gatewayConfigSecret = new sm.CfnSecret(stack, "GatewayConfig", {
    name: "agentcore-gateway-config",
    description: "AgentCore Gateway M2M credentials for Runtime agent",
    secretString: Fn.toJsonString({
      clientId: m2mClient.userPoolClientId,
      clientSecret: gatewayClientSecret,
      tokenEndpoint: tokenEndpoint,
      gatewayUrl: gateway.gatewayUrl,
      scopes: gatewayScope,
    }),
  });

  // CfnSecretが作成される前にCustom Resourceが完成している必要がある
  gatewayConfigSecret.node.addDependency(getClientSecretCR);

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

  return { runtime, gateway };
}
