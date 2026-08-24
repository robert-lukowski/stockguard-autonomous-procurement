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

  it("keeps Terraform-managed recording disabled by default", () => {
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

  it("commits no account id or E.164 phone number in Terraform", () => {
    expect(allTf).not.toMatch(/\b\d{12}\b/);
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

  it("keeps the Connect flow minimal and recording-free", () => {
    const connect = tf("connect.tf");
    expect(connect).toContain("ConnectParticipantWithLexBot");
    expect(connect).toContain("DisconnectParticipant");
    expect(connect).not.toContain("UpdateContactRecordingBehavior");
    expect(connect).not.toContain("aws_connect_phone_number");
  });

  it("keeps CloudWatch retention explicit", () => {
    expect(tf("lambda.tf")).toContain("retention_in_days");
    expect(tf("variables.tf")).toMatch(
      /variable "log_retention_days"[\s\S]*?default\s*=\s*\d+/,
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

  it("keeps simulator_enabled as the only runtime toggle in active workflows", () => {
    for (const workflow of [plan, apply]) {
      expect(workflow).toContain("simulator_enabled:");
      expect(workflow).not.toContain("recovery_mode:");
      expect(workflow).not.toContain("enable_call_recording:");
    }
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
