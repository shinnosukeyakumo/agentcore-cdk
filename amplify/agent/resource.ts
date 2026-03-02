import { Stack, SecretValue } from "aws-cdk-lib";
import * as agentcore from "@aws-cdk/aws-bedrock-agentcore-alpha";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sm from "aws-cdk-lib/aws-secretsmanager";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { ContainerImageBuild } from "@cdklabs/deploy-time-build";
import { IUserPool, IUserPoolClient } from "aws-cdk-lib/aws-cognito";
import * as path from "path";
import { fileURLToPath } from "url";

// Tavily APIキー（Secrets Manager に保存される）
const TAVILY_API_KEY = "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";

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
  // Runtime 上のエージェントがこのシークレットを直接読み込んで Tavily API を呼び出す
  const tavilySecret = new sm.Secret(stack, "TavilyApiKey", {
    secretName: "agentcore-tavily-apikey",
    description: "Tavily web search API key for AgentCore Runtime agent",
    secretStringValue: SecretValue.unsafePlainText(TAVILY_API_KEY),
  });

  // Runtime の IAMロールに Secrets Manager 読み取り権限を付与
  runtime.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [tavilySecret.secretArn],
    })
  );

  return { runtime };
}
