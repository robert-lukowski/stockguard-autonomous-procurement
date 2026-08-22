import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static safety invariants for the infrastructure.
 *
 * `terraform validate` needs provider schemas from the registry, which is not
 * reachable from every environment. These checks need nothing but the files,
 * and they guard the properties that actually matter: that deploying cannot
 * by itself start answering calls, that nothing grants broad IAM, and that
 * apply can never fire automatically.
 */
const tfDir = __dirname;
const repoRoot = join(tfDir, "..", "..");

function tf(name: string): string {
  return readFileSync(join(tfDir, name), "utf8");
}
function repoFile(...parts: string[]): string {
  return readFileSync(join(repoRoot, ...parts), "utf8");
}
const allTf = readdirSync(tfDir)
  .filter((f) => f.endsWith(".tf"))
  .map((f) => tf(f))
  .join("\n");

describe("infrastructure safety invariants", () => {
  it("does not arm the simulator merely by deploying", () => {
    expect(tf("variables.tf")).toMatch(
      /variable "simulator_enabled"[\s\S]*?default\s*=\s*false/,
    );
  });

  it("grants the Lambda role nothing beyond CloudWatch Logs", () => {
    const iam = tf("iam.tf");
    expect(iam).toContain("logs:CreateLogStream");
    expect(iam).toContain("logs:PutLogEvents");
    // Any data-plane permission here would contradict a handler that makes
    // no AWS calls at all.
    for (const forbidden of ["dynamodb:", "s3:", "secretsmanager:", "kms:", "lex:"]) {
      expect(iam).not.toContain(forbidden);
    }
  });

  it("never grants broad managed policies anywhere", () => {
    const deployRole = repoFile("infrastructure", "bootstrap", "github-deploy-role.yml");
    for (const banned of ["AdministratorAccess", "PowerUserAccess", "IAMFullAccess"]) {
      expect(allTf).not.toContain(banned);
      expect(deployRole).not.toContain(banned);
    }
  });

  it("bounds Lambda concurrency so a runaway cannot fan out", () => {
    expect(tf("lambda.tf")).toMatch(/reserved_concurrent_executions\s*=\s*[12]\b/);
  });

  it("bounds CloudWatch retention explicitly", () => {
    expect(tf("lambda.tf")).toContain("retention_in_days");
    expect(tf("variables.tf")).toMatch(
      /variable "log_retention_days"[\s\S]*?default\s*=\s*\d+/,
    );
  });

  it("keeps the recording bucket private, encrypted and expiring", () => {
    const recording = tf("recording.tf");
    expect(recording).toContain("block_public_acls       = true");
    expect(recording).toContain("restrict_public_buckets = true");
    expect(recording).toContain("sse_algorithm = \"AES256\"");
    expect(recording).toContain("aws_s3_bucket_lifecycle_configuration");
    // Only our Connect instance may write, and only over TLS.
    expect(recording).toContain("aws:SourceArn");
    expect(recording).toContain("aws:SecureTransport");
  });

  it("commits no account id, secret or phone number", () => {
    // A 12-digit literal would be an account id; +1 followed by digits a number.
    expect(allTf).not.toMatch(/\b\d{12}\b/);
    expect(allTf).not.toMatch(/\+1\d{6,}/);
    expect(allTf).not.toMatch(/(secret|api[_-]?key|password)\s*=\s*"[^"]+"/i);
  });

  it("pins the account and refuses a foreign one", () => {
    expect(tf("providers.tf")).toContain("allowed_account_ids");
    expect(tf("main.tf")).toContain("aws_caller_identity");
  });

  it("does not create a Connect instance or claim a phone number", () => {
    expect(allTf).not.toContain("resource \"aws_connect_instance\"");
    expect(allTf).not.toContain("aws_connect_phone_number");
  });

  it("defers DynamoDB, Secrets Manager and KMS to a later architecture", () => {
    expect(allTf).not.toContain("resource \"aws_dynamodb_table\"");
    expect(allTf).not.toContain("resource \"aws_secretsmanager_secret\"");
    expect(allTf).not.toContain("resource \"aws_kms_key\"");
  });
});

describe("workflow safety invariants", () => {
  const plan = repoFile(".github", "workflows", "terraform-plan.yml");
  const apply = repoFile(".github", "workflows", "terraform-apply.yml");

  it("never applies from the plan workflow", () => {
    expect(plan).not.toMatch(/terraform\s+apply/);
  });

  it("gives apply no automatic trigger at all", () => {
    const triggers = apply.slice(apply.indexOf("\non:"), apply.indexOf("\npermissions:"));
    expect(triggers).toContain("workflow_dispatch");
    for (const automatic of ["push:", "pull_request:", "schedule:", "release:"]) {
      expect(triggers).not.toContain(automatic);
    }
  });

  it("gates apply behind main, a typed confirmation and a protected environment", () => {
    expect(apply).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(apply).toContain('inputs.confirm }}" = "APPLY"');
    expect(apply).toContain("environment:");
    expect(apply).toContain("aws-qualification");
  });

  it("applies exactly the plan it just produced", () => {
    expect(apply).toMatch(/terraform plan[^\n]*-out=tfplan/);
    expect(apply).toMatch(/terraform apply[^\n]*tfplan/);
  });

  it("masks account identifiers in both workflows", () => {
    expect(plan).toContain("::add-mask::");
    expect(apply).toContain("::add-mask::");
  });

  it("uses OIDC rather than static AWS keys", () => {
    for (const workflow of [plan, apply]) {
      expect(workflow).toContain("id-token: write");
      expect(workflow).not.toContain("AWS_SECRET_ACCESS_KEY");
      expect(workflow).not.toContain("aws_access_key_id");
    }
  });

  it("leaves the read-only inventory workflow read-only", () => {
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
