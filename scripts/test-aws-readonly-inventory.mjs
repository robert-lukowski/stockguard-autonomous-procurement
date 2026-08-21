import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = mkdtempSync(join(tmpdir(), "stockguard-aws-inventory-"));
const awsPath = join(directory, "aws");
const logPath = join(directory, "aws.log");
const summaryPath = join(directory, "summary.md");

const fakeAws = `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"${logPath}"
case "$1 $2" in
  "sts get-caller-identity")
    echo "123456789012"
    ;;
  "connect list-instances")
    echo '{"InstanceSummaryList":[{"Id":"instance-private-id","InstanceAlias":"robert-support","InstanceStatus":"ACTIVE","InboundCallsEnabled":true,"OutboundCallsEnabled":true}]}'
    ;;
  "connect list-contact-flows")
    echo '{"ContactFlowSummaryList":[{"Id":"private-flow-id","Arn":"arn:private","Name":"Default inbound flow","ContactFlowType":"CONTACT_FLOW","ContactFlowState":"ACTIVE","ContactFlowStatus":"PUBLISHED"},{"Id":"stockguard-private-id","Arn":"arn:private","Name":"StockGuard supplier simulator","ContactFlowType":"CONTACT_FLOW","ContactFlowState":"ACTIVE","ContactFlowStatus":"SAVED"}]}'
    ;;
  "connect list-lambda-functions")
    echo '{"LambdaFunctions":["arn:aws:lambda:eu-central-1:123456789012:function:private-function"]}'
    ;;
  "connect list-bots")
    echo '{"LexBots":[]}'
    ;;
  "connect list-integration-associations")
    echo '{"IntegrationAssociationSummaryList":[{"IntegrationAssociationId":"private-id","IntegrationAssociationArn":"arn:private","InstanceId":"instance-private-id","IntegrationType":"APPLICATION"}]}'
    ;;
  *)
    echo "Unexpected fake AWS command: $*" >&2
    exit 90
    ;;
esac
`;

writeFileSync(awsPath, fakeAws);
chmodSync(awsPath, 0o700);
writeFileSync(summaryPath, "");

try {
  const result = spawnSync("bash", ["scripts/aws-readonly-inventory.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      AWS_ACCOUNT_ID: "123456789012",
      AWS_REGION: "eu-central-1",
      CONNECT_INSTANCE_ALIAS: "robert-support",
      GITHUB_STEP_SUMMARY: summaryPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(`Inventory fixture failed: ${result.stderr}`);
  }

  const output = JSON.parse(result.stdout);
  if (
    output.mode !== "READ_ONLY" ||
    output.instance.alias !== "robert-support" ||
    output.contactFlows.total !== 2 ||
    output.contactFlows.stockGuardFlows.length !== 1 ||
    output.lambdaFunctions.associatedFunctionCount !== 1 ||
    output.lexV2Bots.associatedLexV2BotCount !== 0 ||
    output.integrations.total !== 1 ||
    output.phoneNumbersInspected !== false ||
    output.resourcesChanged !== false
  ) {
    throw new Error("Sanitized inventory output did not match the fixture");
  }

  const serializedOutput = `${result.stdout}\n${readFileSync(summaryPath, "utf8")}`;
  for (const privateValue of [
    "123456789012",
    "instance-private-id",
    "private-flow-id",
    "private-function",
    "arn:private",
  ]) {
    if (serializedOutput.includes(privateValue)) {
      throw new Error(`Inventory leaked a private fixture value: ${privateValue}`);
    }
  }

  const calls = readFileSync(logPath, "utf8");
  for (const expected of [
    "sts get-caller-identity",
    "connect list-instances",
    "connect list-contact-flows",
    "connect list-lambda-functions",
    "connect list-bots",
    "connect list-integration-associations",
  ]) {
    if (!calls.includes(expected)) {
      throw new Error(`Expected AWS call was not made: ${expected}`);
    }
  }
  if (/phone-number|\b(create|update|delete|put|start|stop|associate|disassociate)\b/i.test(calls)) {
    throw new Error("Inventory fixture observed a forbidden AWS operation");
  }

  console.log("AWS read-only inventory fixture verified.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
