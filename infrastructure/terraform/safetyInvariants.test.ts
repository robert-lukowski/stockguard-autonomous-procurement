import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const tfDir = __dirname;
const repoRoot = join(tfDir, "..", "..");

function tf(name: string): string {
  return readFileSync(join(tfDir, name), "utf8");
}

function repoFile(...parts: string[]): string {
  return readFileSync(join(repoRoot, ...parts), "utf8");
}

function collectTerraform(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".terraform" || entry.name === "build") continue;
      files.push(...collectTerraform(full));
    } else if (entry.isFile() && entry.name.endsWith(".tf")) {
      files.push(readFileSync(full, "utf8"));
    }
  }
  return files;
}

const allTf = collectTerraform(tfDir).join("\n");

function withoutComments(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

describe("infrastructure invariants", () => {
  it("keeps the simulator default disabled in Terraform itself", () => {
    expect(tf("variables.tf")).toMatch(
      /variable "simulator_enabled"[\s\S]*?default\s*=\s*false/,
    );
  });

  it("keeps optional recording disabled by default", () => {
    expect(tf("variables.tf")).toMatch(
      /variable "enable_call_recording"[\s\S]*?default\s*=\s*false/,
    );
  });

  it("uses zero concurrency only for the disarmed simulator", () => {
    expect(tf("lambda.tf")).toContain(
      "reserved_concurrent_executions = var.simulator_enabled ? -1 : 0",
    );
  });

  it("wires SIMULATOR_ENABLED directly to var.simulator_enabled", () => {
    expect(tf("lambda.tf")).toMatch(
      /SIMULATOR_ENABLED\s*=\s*tostring\(var\.simulator_enabled\)/,
    );
  });

  it("does not create a Connect instance or claim a phone number", () => {
    expect(allTf).not.toContain('resource "aws_connect_instance"');
    expect(allTf).not.toContain("aws_connect_phone_number");
  });

  it("commits no E.164 number and only the approved recording KMS account id", () => {
    const approvedKmsArn =
      "arn:aws:kms:eu-central-1:854010287302:key/00a17f01-a252-43f7-a803-d3e5df363c9b";
    expect(allTf.replace(approvedKmsArn, "")).not.toMatch(/\b\d{12}\b/);
    expect(allTf).not.toMatch(/\+1\d{6,}/);
  });

  it("contains no broad managed-policy attachment in source", () => {
    const deployRole = repoFile("infrastructure", "bootstrap", "github-deploy-role.yml");
    for (const banned of ["AdministratorAccess", "PowerUserAccess", "IAMFullAccess"]) {
      expect(allTf).not.toContain(banned);
      expect(deployRole).not.toContain(banned);
    }
  });

  it("pins the AWS provider to the configured account", () => {
    expect(tf("providers.tf")).toContain("allowed_account_ids");
    expect(tf("main.tf")).toContain("aws_caller_identity");
  });

  it("keeps the supplier Lambda invoke permission pinned to the Lex alias", () => {
    const lambda = tf("lambda.tf");
    expect(lambda).toContain("source_arn    = local.lex_bot_alias_arn");
    expect(lambda).not.toMatch(/source_arn\s*=\s*"[^"]*bot-alias\/\*/);
  });

  it("enables automated-interaction recording before the supplier greeting", () => {
    const connect = tf("connect.tf");
    const loggingStart = connect.indexOf('Identifier  = "set-logging"');
    const recordingStart = connect.indexOf('Identifier = "enable-recording"');
    const greetingStart = connect.indexOf('Identifier = "supplier-greeting"');

    expect(connect).toContain("ConnectParticipantWithLexBot");
    expect(connect).toContain("DisconnectParticipant");
    expect(loggingStart).toBeGreaterThan(-1);
    expect(recordingStart).toBeGreaterThan(loggingStart);
    expect(greetingStart).toBeGreaterThan(recordingStart);
    expect(connect.slice(loggingStart, recordingStart)).toContain(
      'NextAction = "enable-recording"',
    );
    const recording = connect.slice(recordingStart, greetingStart);
    expect(recording).toContain('Type       = "UpdateContactRecordingBehavior"');
    expect(recording).toMatch(
      /RecordingBehavior = {\s*(?:#[^\n]*\s*)*RecordedParticipants = \[\]\s*IVRRecordingBehavior = var\.enable_call_recording \? "Enabled" : "Disabled"\s*}/,
    );
    expect(recording).not.toContain('"Agent"');
    expect(recording).not.toContain('"Customer"');
    expect(recording).not.toContain("ScreenRecordedParticipants");
    expect(recording).not.toContain("AnalyticsBehavior");
    expect(recording).toContain('NextAction = "supplier-greeting"');
    expect(recording).not.toContain("Errors");
    expect(recording).not.toMatch(/NextAction = "lex-(?:primary|retry)"/);
    expect(connect).not.toContain("aws_connect_phone_number");
  });

  it("uses exactly one bounded Lex retry and then disconnects", () => {
    const connect = tf("connect.tf");
    const greetingStart = connect.indexOf('Identifier = "supplier-greeting"');
    const primaryStart = connect.indexOf('Identifier = "lex-primary"');
    const retryStart = connect.indexOf('Identifier = "lex-retry"');
    const disconnectStart = connect.indexOf('Identifier  = "disconnect"');
    const greeting = connect.slice(greetingStart, primaryStart);
    const primary = connect.slice(primaryStart, retryStart);
    const retry = connect.slice(retryStart, disconnectStart);

    expect(greetingStart).toBeGreaterThan(-1);
    expect(primaryStart).toBeGreaterThan(greetingStart);
    expect(retryStart).toBeGreaterThan(primaryStart);
    expect(disconnectStart).toBeGreaterThan(retryStart);
    expect(connect.match(/Type\s*=\s*"ConnectParticipantWithLexBot"/g)).toHaveLength(2);
    expect(greeting).toContain('Type       = "MessageParticipant"');
    expect(greeting).toContain(
      "Ridgeline Industrial Supply, sales desk. How can I help you today?",
    );
    expect(greeting).toContain('NextAction = "lex-primary"');
    expect(primary).not.toContain(
      "Ridgeline Industrial Supply, sales desk. How can I help you today?",
    );
    expect(primary).toContain('Text = "Please go ahead."');
    expect(connect).toContain(
      "Sorry, I didn't catch that. Could you repeat your last question?",
    );
    expect(primary).toContain('NextAction = "disconnect"');
    expect(primary).toContain(
      '{ ErrorType = "NoMatchingCondition", NextAction = "disconnect" },',
    );
    expect(primary).toContain(
      '{ ErrorType = "NoMatchingError", NextAction = "lex-retry" },',
    );
    expect(primary.match(/NextAction = "lex-retry"/g)).toHaveLength(1);
    expect(retry.match(/NextAction = "disconnect"/g)).toHaveLength(3);
    expect(retry).not.toMatch(/NextAction = "lex-(?:primary|retry)"/);
  });

  it("requires an actual procurement request instead of classifying disclosure alone", () => {
    const lex = tf("lex.tf");
    const quoteStart = lex.indexOf('resource "aws_lexv2models_intent" "get_supplier_quote"');
    const validityStart = lex.indexOf(
      'resource "aws_lexv2models_intent" "confirm_offer_validity"',
    );
    const quote = lex.slice(quoteStart, validityStart);

    expect(quoteStart).toBeGreaterThan(-1);
    expect(validityStart).toBeGreaterThan(quoteStart);
    expect(quote).toContain("An AI or StockGuard disclosure by itself is not a quote request");
    for (const utterance of [
      "Do you have this part in stock",
      "What is the unit price",
      "When could you deliver",
      "I'm calling to check availability for this item",
      "I need to confirm availability and pricing",
      "Can you confirm stock unit price and delivery",
      "I'm checking availability for eight units",
    ]) {
      expect(quote).toContain(utterance);
    }
    for (const disclosureOnly of [
      "I'm an AI procurement assistant calling on behalf of StockGuard",
      "I'm calling on behalf of StockGuard for a supplier qualification",
      "This call requests supplier availability and commercial information",
    ]) {
      expect(quote).not.toContain(disclosureOnly);
    }
  });

  it("enables Bedrock Assisted NLU only as a fallback to classic Lex NLU", () => {
    const lex = tf("lex.tf");
    expect(lex).toContain('Action   = "bedrock:InvokeModel"');
    expect(lex).toContain('Resource = "arn:aws:bedrock:*::foundation-model/*"');
    expect(lex).toContain("aws lexv2-models update-bot-locale");
    expect(lex).toContain('"enabled":true,"assistedNluMode":"Fallback"');
    expect(lex).not.toContain('"assistedNluMode":"Primary"');
    expect(lex).toContain("generation-4-assisted-nlu-fallback");
  });

  it("scopes supplier response realization to Nova Micro with a short fallback timeout", () => {
    const iam = tf("iam.tf");
    const lambda = tf("lambda.tf");
    const handler = repoFile(
      "infrastructure",
      "terraform",
      "lambda",
      "supplierSimulatorHandler.ts",
    );
    const pkg = JSON.parse(repoFile("package.json"));
    const profileArn =
      "arn:aws:bedrock:eu-central-1:${var.aws_account_id}:inference-profile/eu.amazon.nova-micro-v1:0";
    const destinationModelArns = [
      "arn:aws:bedrock:eu-central-1::foundation-model/amazon.nova-micro-v1:0",
      "arn:aws:bedrock:eu-north-1::foundation-model/amazon.nova-micro-v1:0",
      "arn:aws:bedrock:eu-west-1::foundation-model/amazon.nova-micro-v1:0",
      "arn:aws:bedrock:eu-west-3::foundation-model/amazon.nova-micro-v1:0",
    ];

    expect(iam.match(/actions\s*=\s*\["bedrock:InvokeModel"\]/g)).toHaveLength(2);
    expect(iam).toContain(profileArn);
    for (const arn of destinationModelArns) expect(iam).toContain(arn);
    expect(iam).toContain('variable = "bedrock:InferenceProfileArn"');
    expect(iam.match(new RegExp(profileArn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(2);
    expect(iam).not.toMatch(/actions\s*=\s*\["bedrock:\*"\]/);
    expect(iam).not.toMatch(/resources\s*=\s*\[\s*"\*"/);
    expect(lambda).toMatch(
      /BEDROCK_SUPPLIER_MODEL_ID\s*=\s*"eu\.amazon\.nova-micro-v1:0"/,
    );
    expect(lambda).not.toMatch(
      /BEDROCK_SUPPLIER_MODEL_ID\s*=\s*"amazon\.nova-micro-v1:0"/,
    );
    expect(lambda).not.toContain("global.amazon.nova-micro-v1:0");
    expect(lambda).toMatch(/BEDROCK_SUPPLIER_TIMEOUT_MS\s*=\s*"3000"/);
    expect(handler).toContain('region: "eu-central-1"');
    expect(pkg.dependencies["@aws-sdk/client-bedrock-runtime"]).toBeDefined();
    expect(pkg.scripts["build:lambda"]).not.toContain(
      "external:@aws-sdk/client-bedrock-runtime",
    );
  });

  it("exposes offer validity as a first-class natural-language intent", () => {
    const lex = tf("lex.tf");
    expect(lex).toContain('name        = "ConfirmOfferValidity"');
    expect(lex).toContain("How long is the quote valid");
    expect(lex).toContain("When does this offer expire");
    expect(lex).toContain("aws_lexv2models_intent.confirm_offer_validity.id");
  });

  it("keeps CloudWatch retention explicit", () => {
    expect(tf("lambda.tf")).toContain("retention_in_days");
    expect(tf("variables.tf")).toMatch(
      /variable "log_retention_days"[\s\S]*?default\s*=\s*\d+/,
    );
  });

  it("declares no recording bucket or Connect storage association", () => {
    expect(allTf).not.toContain('resource "aws_s3_bucket" "recordings"');
    expect(allTf).not.toContain('resource "aws_s3_bucket_public_access_block" "recordings"');
    expect(allTf).not.toContain('resource "aws_s3_bucket_versioning" "recordings"');
    expect(allTf).not.toContain(
      'resource "aws_s3_bucket_server_side_encryption_configuration" "recordings"',
    );
    expect(allTf).not.toContain(
      'resource "aws_s3_bucket_lifecycle_configuration" "recordings"',
    );
    expect(allTf).not.toContain('resource "aws_s3_bucket_policy" "recordings"');
    expect(allTf).not.toContain(
      'resource "aws_connect_instance_storage_config" "call_recordings"',
    );
  });

  it("pins the pre-existing recording storage as non-secret qualification defaults", () => {
    const variables = tf("variables.tf");
    const root = tf("main.tf");
    const caller = tf("qualification-caller.tf");
    expect(variables).toMatch(
      /variable "recording_bucket_name"[\s\S]*?default\s*=\s*"amazon-connect-93f5db840470"/,
    );
    expect(variables).toMatch(
      /variable "recording_prefix"[\s\S]*?default\s*=\s*"connect\/robert-support\/CallRecordings"/,
    );
    expect(variables).toMatch(
      /variable "recording_kms_key_arn"[\s\S]*?default\s*=\s*"arn:aws:kms:eu-central-1:854010287302:key\/00a17f01-a252-43f7-a803-d3e5df363c9b"/,
    );
    expect(variables).toContain("Terraform never creates or owns the bucket or storage");
    expect(root).toContain(
      'recording_bucket_arn      = "arn:aws:s3:::${var.recording_bucket_name}"',
    );
    expect(caller).toContain("recording_bucket_name     = var.recording_bucket_name");
    expect(caller).toContain("recording_prefix          = var.recording_prefix");
    expect(caller).toContain("recording_kms_key_arn     = var.recording_kms_key_arn");
  });

  it("gives only the caller scoped recording lookup permissions and environment", () => {
    const caller = repoFile(
      "infrastructure",
      "terraform",
      "modules",
      "qualification-caller",
      "main.tf",
    );
    const pkg = JSON.parse(repoFile("package.json"));

    expect(caller).toContain('Action   = ["s3:ListBucket"]');
    expect(caller).toContain('"s3:prefix" = [');
    expect(caller).toContain('"${var.recording_prefix}/*"');
    expect(caller).toContain('Action   = ["s3:GetObject"]');
    expect(caller).toContain('Resource = "${var.recording_bucket_arn}/${var.recording_prefix}/*"');
    expect(caller).toContain('Action   = ["kms:Decrypt"]');
    expect(caller).toContain("Resource = var.recording_kms_key_arn");
    expect(caller).not.toMatch(/Action\s*=\s*\["s3:\*"\]/);
    expect(caller).not.toMatch(/Action\s*=\s*\["kms:\*"\]/);
    expect(caller).not.toContain("kms:DescribeKey");
    expect(caller).not.toContain("kms:GenerateDataKey");
    for (const variable of [
      "RECORDING_ENABLED",
      "RECORDING_BUCKET",
      "RECORDING_PREFIX",
      "RECORDING_URL_TTL_SECONDS",
    ]) {
      expect(caller).toContain(variable);
    }
    expect(tf("main.tf")).toContain("recording_url_ttl_seconds = 300");
    expect(pkg.dependencies["@aws-sdk/client-s3"]).toBeDefined();
    expect(pkg.dependencies["@aws-sdk/s3-request-presigner"]).toBeDefined();
    expect(pkg.scripts["build:lambda"]).not.toContain("external:@aws-sdk/client-s3");
    expect(pkg.scripts["build:lambda"]).not.toContain(
      "external:@aws-sdk/s3-request-presigner",
    );
  });
});

describe("Terraform workflow invariants", () => {
  const plan = repoFile(".github", "workflows", "terraform-plan.yml");
  const apply = repoFile(".github", "workflows", "terraform-apply.yml");

  it("never applies from the plan workflow", () => {
    expect(plan).not.toMatch(/terraform\s+apply/);
  });

  it("keeps apply manual-only", () => {
    const triggers = apply.slice(apply.indexOf("\non:"), apply.indexOf("\npermissions:"));
    expect(triggers).toContain("workflow_dispatch");
    for (const automatic of ["push:", "pull_request:", "schedule:", "release:"]) {
      expect(triggers).not.toContain(automatic);
    }
  });

  it("requires explicit APPLY confirmation on main", () => {
    expect(apply).toContain('inputs.confirm }}" = "APPLY"');
    expect(apply).toContain('test "$GITHUB_REF" = "refs/heads/main"');
  });

  it("keeps the apply job behind the aws-qualification environment", () => {
    expect(apply).toContain("environment:");
    expect(apply).toContain("name: aws-qualification");
  });

  it("plans and then applies exactly the saved tfplan", () => {
    expect(apply).toMatch(/terraform plan[^\n]*-out=tfplan/);
    expect(apply).toMatch(/terraform apply[^\n]*tfplan/);
  });

  it("keeps the PR validation job credential-free", () => {
    const stripped = withoutComments(plan);
    const validateStart = stripped.indexOf("\n  validate:");
    const planStart = stripped.indexOf("\n  plan:");
    const validate = stripped.slice(validateStart, planStart);
    expect(validate).toContain("terraform validate");
    expect(validate).not.toContain("configure-aws-credentials");
    expect(validate).not.toContain("id-token: write");
    expect(validate).not.toContain("environment:");
  });

  it("runs the AWS plan only on manual dispatch from main", () => {
    expect(plan).toContain("github.event_name == 'workflow_dispatch'");
    expect(plan).toContain("github.ref == 'refs/heads/main'");
    expect(plan).toContain("vars.AWS_DEPLOY_ROLE_ARN != ''");
  });

  it("uses the same encrypted remote state for plan and apply", () => {
    for (const workflow of [plan, apply]) {
      expect(workflow).toContain('-backend-config="key=runtime/terraform.tfstate"');
      expect(workflow).toContain('-backend-config="use_lockfile=true"');
      expect(workflow).toContain('-backend-config="encrypt=true"');
      expect(workflow).toContain("secrets.TERRAFORM_STATE_BUCKET");
    }
  });

  it("uses the same recording input in plan and apply", () => {
    for (const workflow of [plan, apply]) {
      expect(workflow).toContain("simulator_enabled:");
      expect(workflow).toMatch(
        /enable_call_recording:[\s\S]*?description: 'Include existing Connect automated-interaction recording in the reviewed plan'[\s\S]*?default: false[\s\S]*?TF_VAR_enable_call_recording: \$\{\{ inputs\.enable_call_recording \}\}/,
      );
      expect(workflow).toMatch(
        /echo "enable_call_recording: \\`\$\{\{ inputs\.enable_call_recording \}\}\\`"/,
      );
      expect(workflow).not.toContain("recovery_mode:");
    }
    expect(apply).toContain("--expect-recording \"$RECORDING\"");
  });

  it("uses OIDC rather than static AWS keys", () => {
    for (const workflow of [plan, apply]) {
      expect(workflow).toContain("id-token: write");
      expect(workflow).not.toContain("AWS_SECRET_ACCESS_KEY");
      expect(workflow).not.toContain("aws_access_key_id");
    }
  });

  it("verifies the deployed runtime after apply", () => {
    const stripped = withoutComments(apply);
    const applyStep = stripped.indexOf("terraform apply");
    const verify = stripped.indexOf("scripts/qualification/verifyAwsRuntime.sh");
    expect(applyStep).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(applyStep);
  });

  it("leaves the inventory workflow read-only", () => {
    const inventory = repoFile(".github", "workflows", "aws-readonly-inventory.yml");
    expect(inventory).not.toMatch(/terraform/i);
    expect(inventory).toContain("workflow_dispatch");
  });
});

describe("qualification harness safety", () => {
  const harness = repoFile("scripts", "qualification", "en-supplier-qualification.mjs");

  it("is disabled unless explicitly armed", () => {
    expect(harness).toContain("I-UNDERSTAND-THIS-PLACES-A-REAL-CALL");
    expect(harness).toContain("QUALIFICATION_ARMED");
  });

  it("contains no credential and no phone number", () => {
    expect(harness).not.toMatch(/\+1\d{6,}/);
    expect(harness).not.toMatch(/(sk-|Bearer\s+[A-Za-z0-9]{8,})/);
  });

  it("enforces exactly one call per invocation", () => {
    expect(harness).toContain("places exactly one call per invocation");
  });

  it("requires an interactive terminal, so CI cannot run it", () => {
    expect(harness).toContain("process.stdin.isTTY");
  });

  it("is not wired into any npm script", () => {
    const pkg = JSON.parse(repoFile("package.json"));
    expect(JSON.stringify(pkg.scripts)).not.toContain("qualification");
  });
});

describe("live recording UI invariants", () => {
  const panel = repoFile("src", "ui", "LiveQualificationPanel.tsx");

  it("renders the workflow before starting bounded recording polling", () => {
    expect(panel.indexOf("setResult(envelope)")).toBeLessThan(
      panel.indexOf("pollForRecording({"),
    );
    expect(panel).toContain("Recording is processing…");
    expect(panel).toContain("Listen to live qualification");
  });

  it("uses a non-autoplay player and persists neither PIN nor URL", () => {
    expect(panel).toMatch(/<audio[\s\S]*?controls[\s\S]*?preload="metadata"/);
    expect(panel).not.toMatch(/<audio[\s\S]*?autoPlay/);
    expect(panel).not.toContain("localStorage");
    expect(panel).not.toContain("sessionStorage");
  });
});
