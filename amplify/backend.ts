import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { createAgentCoreRuntime } from "./agent/resource";

const backend = defineBackend({
  auth,
});

// AgentCore Runtime 専用のCDKスタックを作成
const agentCoreStack = backend.createStack("AgentCoreStack");

const { runtime, gateway } = createAgentCoreRuntime(
  agentCoreStack,
  backend.auth.resources.userPool,
  backend.auth.resources.userPoolClient
);

// AgentCore Runtime ARN と Gateway URL を amplify_outputs.json の custom フィールドに出力
// → フロントエンドが自動的に読み込んで使用する
backend.addOutput({
  custom: {
    agentRuntimeArn: runtime.agentRuntimeArn,
    gatewayArn: gateway.gatewayArn,
  },
});
