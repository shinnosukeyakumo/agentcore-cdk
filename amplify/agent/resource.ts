import { Stack, Duration, SecretValue, CustomResource, Fn } from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "@aws-cdk/aws-bedrock-agentcore-alpha";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sm from "aws-cdk-lib/aws-secretsmanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
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
                    default: 5,
                    description: "Maximum number of search results to return",
                  },
                  search_depth: {
                    type: "string",
                    enum: ["basic", "advanced"],
                    default: "basic",
                    description:
                      "Search depth: basic (fast) or advanced (thorough)",
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
// 重要: cr.Provider フレームワーク用なので cfnresponse.send() は使わず return dict にする
// cfnresponse.send() は CloudFormation の直接Lambdaハンドラー用であり、
// cr.Provider では Lambda が return した値がフレームワークに渡される
const IDENTITY_PROVIDER_LAMBDA_CODE = `
import boto3

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
            # すでに存在する場合は既存のARNを返す
            if ("already exists" in err_msg.lower()
                    or "conflict" in err_msg.lower()
                    or "ConflictException" in err_msg):
                resp = client.get_api_key_credential_provider(name=provider_name)
                arn = resp["credentialProviderArn"]
            else:
                raise Exception(f"Failed to create credential provider: {err_msg}")

        # cr.Provider では return dict でフレームワークに結果を返す
        return {
            "PhysicalResourceId": provider_name,
            "Data": {"CredentialProviderArn": arn},
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

  // スタック名から環境IDを生成（Amplifyが付与するブランチ名を含む）
  const stackNameParts = stack.stackName.split("-");
  const rawEnvId =
    stackNameParts.length >= 4
      ? stackNameParts[3]
      : stack.stackName.slice(-10);
  const envId = rawEnvId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

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

  // ===== Tavily APIキーを Secrets Manager に保存 =====
  // AgentCore Identity が参照する元データ
  const tavilySecret = new sm.Secret(stack, "TavilyApiKey", {
    secretName: "agentcore-tavily-apikey",
    description: "Tavily web search API key for AgentCore Identity",
    secretStringValue: SecretValue.unsafePlainText(TAVILY_API_KEY),
  });

  // ===== AgentCore Identity 認証プロバイダーを作成（Lambda Custom Resource） =====
  // CDK L2 では Identity プロバイダーの直接作成をサポートしていないため
  // Lambda Custom Resource を使って boto3 API を呼び出す
  const identityFn = new lambda.Function(stack, "IdentityProviderFn", {
    runtime: lambda.Runtime.PYTHON_3_12,
    handler: "index.handler",
    timeout: Duration.minutes(5),
    code: lambda.Code.fromInline(IDENTITY_PROVIDER_LAMBDA_CODE),
  });

  // bedrock-agentcore コントロールプレーンのすべての操作を許可
  identityFn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["bedrock-agentcore:*"],
      resources: ["*"],
    })
  );
  // create_api_key_credential_provider は内部的に Secrets Manager にAPIキーを保存するため
  // secretsmanager:CreateSecret 等の権限も必要
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
    },
  });

  const identityProviderArn =
    identityProvider.getAttString("CredentialProviderArn");

  // ===== AgentCore Gateway（L2コンストラクト） =====
  // デフォルト設定：MCPプロトコル + Cognito M2M認証（自動作成）
  // Gateway名はハイフン区切りのみ許可（アンダースコア不可）
  const gateway = new agentcore.Gateway(stack, "AgentGateway", {
    gatewayName: `agent-gateway-${envId}`,
    // MCP設定は空にできない → supportedVersions を必ず指定する
    protocolConfiguration: agentcore.GatewayProtocol.mcp({
      supportedVersions: [agentcore.MCPProtocolVersion.MCP_2025_03_26],
    }),
    // authorizerConfiguration を省略 → Cognito User Pool が自動作成される
  });

  // Tavily検索APIをGatewayのOpenAPIターゲットとして追加
  // Identity に登録されたAPIキーが自動的に Authorization ヘッダーに注入される
  gateway.addOpenApiTarget("TavilySearch", {
    gatewayTargetName: "tavily-search",
    apiSchema: agentcore.ApiSchema.fromInline(TAVILY_OPENAPI_SCHEMA),
    credentialProviderConfigurations: [
      agentcore.GatewayCredentialProvider.fromApiKeyIdentityArn({
        providerArn: identityProviderArn,
        secretArn: tavilySecret.secretArn,
        // Tavily APIキーを Authorization: Bearer ヘッダーとして注入
        credentialLocation: agentcore.ApiKeyCredentialLocation.header({
          credentialParameterName: "Authorization",
          credentialPrefix: "Bearer ",
        }),
      }),
    ],
  });

  // ===== Gateway M2M認証情報を取得 =====
  // Gatewayが自動作成したCognito UserPoolClientのシークレットを取得する
  const getClientSecretCR = new cr.AwsCustomResource(
    stack,
    "GetGatewayClientSecret",
    {
      onUpdate: {
        service: "CognitoIdentityServiceProvider",
        action: "describeUserPoolClient",
        parameters: {
          UserPoolId: gateway.userPool!.userPoolId,
          ClientId: gateway.userPoolClient!.userPoolClientId,
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

  // Cognito クライアントに許可されている実際のスコープを動的に取得
  // Gateway が自動生成するスコープは "<stack-id>-AgentGateway-<hash>/read" の形式で
  // デプロイごとに変わるため、describeUserPoolClient の結果から直接取得する
  const gatewayScope = getClientSecretCR.getResponseField(
    "UserPoolClient.AllowedOAuthScopes.0"
  );

  // ===== Gateway M2M接続情報をまとめてSecrets Managerに保存 =====
  // Runtime上のエージェントがこのシークレットを読み込んでGatewayに接続する
  const gatewayConfigSecret = new sm.CfnSecret(stack, "GatewayConfig", {
    name: "agentcore-gateway-config",
    description: "AgentCore Gateway M2M credentials for Runtime agent",
    secretString: Fn.toJsonString({
      clientId: gateway.userPoolClient!.userPoolClientId,
      clientSecret: gatewayClientSecret,
      tokenEndpoint: gateway.tokenEndpointUrl,
      gatewayUrl: gateway.gatewayUrl,
      scopes: gatewayScope,
    }),
  });

  // CfnSecretが作成される前にGatewayが完成している必要がある
  gatewayConfigSecret.node.addDependency(getClientSecretCR);

  // ===== RuntimeのIAMロールにSecrets Manager読み取り権限を付与 =====
  runtime.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [
        tavilySecret.secretArn,
        // CfnSecretのrefはARNを返す
        cdk.Fn.join("", [
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
