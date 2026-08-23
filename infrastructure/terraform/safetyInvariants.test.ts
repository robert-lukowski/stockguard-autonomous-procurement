import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SIMULATOR_ARMING_ADDRESS,
  // @ts-expect-error - plain .mjs module, deliberately dependency-free
} from "../../scripts/terraform/assertQualificationPlan.mjs";

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

  it("does not attach a recording configuration on the first deployment", () => {
    // Attaching CALL_RECORDINGS would replace whatever the Connect instance
    // already has, and that has not been inspected yet.
    expect(tf("variables.tf")).toMatch(
      /variable "enable_call_recording"[\s\S]*?default\s*=\s*false/,
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

  it("keeps Lambda at zero concurrency until the simulator is armed", () => {
    expect(tf("lambda.tf")).toContain(
      "reserved_concurrent_executions = var.simulator_enabled ? -1 : 0",
    );
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

  it("keeps the Lambda free of any dependency on the generated alias id", () => {
    // The alias's code hook points at the Lambda. If the Lambda also read the
    // alias id, Terraform would report a cycle - which it did.
    const lambda = tf("lambda.tf");
    const functionBlock = lambda.slice(
      lambda.indexOf('resource "aws_lambda_function"'),
      lambda.indexOf('resource "aws_lambda_permission"'),
    );
    expect(functionBlock).not.toContain("awscc_lex_bot_alias");
    expect(functionBlock).toContain("ALLOWED_LEX_ALIAS_NAMES");
  });

  it("still pins the Lambda invoke permission to the real generated alias", () => {
    // Breaking the cycle must not turn into "any Lex alias may invoke us".
    // The ARN is now built once in lex.tf and referenced, so follow the
    // indirection rather than accepting any literal.
    const lambda = tf("lambda.tf");
    expect(lambda).toContain("source_arn    = local.lex_bot_alias_arn");
    expect(lambda).not.toMatch(/source_arn\s*=\s*"[^"]*bot-alias\/\*/);
    expect(tf("lex.tf")).toContain("awscc_lex_bot_alias.supplier_simulator.bot_alias_id");
    expect(tf("lex.tf")).not.toMatch(/lex_bot_alias_arn\s*=\s*"[^"]*bot-alias\/\*/);
  });

  it("defers DynamoDB, Secrets Manager and KMS to a later architecture", () => {
    expect(allTf).not.toContain("resource \"aws_dynamodb_table\"");
    expect(allTf).not.toContain("resource \"aws_secretsmanager_secret\"");
    expect(allTf).not.toContain("resource \"aws_kms_key\"");
  });
});

/**
 * Source-level invariant binding SIMULATOR_ENABLED to var.simulator_enabled.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE PLAN GATE
 *
 * The plan-level check in scripts/terraform/assertQualificationPlan.mjs can
 * only corroborate at map granularity. Terraform collapses an
 * object-constructor expression into a single `references` array for the whole
 * map, so a plan cannot express which KEY references which variable. That
 * leaves one hole the plan can never close: SIMULATOR_ENABLED could be rewired
 * to a different variable while var.simulator_enabled stays referenced
 * elsewhere in the same map, and every plan-level check would still pass.
 *
 * The configuration source can express it, so the invariant lives here. The
 * plan gate remains the runtime check on what is about to be applied; this is
 * the compile-time check on what the configuration says.
 */
describe("simulator flag is wired to exactly one input variable", () => {
  const EXPECTED_EXPRESSION = "tostring(var.simulator_enabled)";

  /**
   * Body of the brace-delimited block whose opening brace is at `open`.
   * `${...}` interpolations are brace-balanced, so plain counting is safe.
   */
  function braceBlock(source: string, open: number): string {
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(open + 1, i);
      }
    }
    return "";
  }

  function nestedBlock(source: string, header: RegExp): string {
    const match = header.exec(source);
    if (!match) return "";
    return braceBlock(source, match.index + match[0].length - 1);
  }

  /** The simulator Lambda's `environment { variables = { ... } }` body. */
  function environmentVariables(hcl: string): string {
    const resource = nestedBlock(
      hcl,
      /resource\s+"aws_lambda_function"\s+"supplier_simulator"\s*\{/,
    );
    const environment = nestedBlock(resource, /environment\s*\{/);
    return nestedBlock(environment, /variables\s*=\s*\{/);
  }

  /** Every right-hand side assigned to SIMULATOR_ENABLED in that block. */
  function simulatorEnabledAssignments(hcl: string): string[] {
    return environmentVariables(hcl)
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter((line) => /^SIMULATOR_ENABLED\s*=/.test(line))
      .map((line) => line.replace(/^SIMULATOR_ENABLED\s*=\s*/, "").trim());
  }

  /** A minimal stand-in used to prove the invariant actually bites. */
  function syntheticLambda(variables: string): string {
    return `resource "aws_lambda_function" "supplier_simulator" {
  function_name = "\${local.name_prefix}-supplier-simulator"

  environment {
    variables = {
${variables}
    }
  }
}
`;
  }

  it("reads the real configuration, not an empty string", () => {
    // Guards against the extractor silently returning "" and every assertion
    // below passing vacuously.
    const block = environmentVariables(tf("lambda.tf"));
    expect(block).toContain("ALLOWED_LEX_BOT_IDS");
    expect(block).toContain("QUALIFICATION_SKU");
  });

  it("assigns SIMULATOR_ENABLED exactly once, from exactly var.simulator_enabled", () => {
    expect(simulatorEnabledAssignments(tf("lambda.tf"))).toEqual([EXPECTED_EXPRESSION]);
  });

  it("guards the same resource the plan gate guards", () => {
    // If the Lambda were renamed, the plan gate would watch one address while
    // this invariant checked another.
    expect(SIMULATOR_ARMING_ADDRESS).toBe("aws_lambda_function.supplier_simulator");
    expect(tf("lambda.tf")).toContain('resource "aws_lambda_function" "supplier_simulator"');
  });

  it.each([
    [
      "the key is removed",
      `      ALLOWED_LEX_LOCALES = local.lex_locale_id`,
    ],
    [
      "it is rewired to another variable",
      `      SIMULATOR_ENABLED = tostring(var.other_flag)`,
    ],
    [
      "it is rewired to a similarly named variable",
      `      SIMULATOR_ENABLED = tostring(var.simulator_enabled_v2)`,
    ],
    [
      "it is rewired to a local",
      `      SIMULATOR_ENABLED = tostring(local.simulator_enabled)`,
    ],
    [
      "it is rewired to a resource attribute",
      `      SIMULATOR_ENABLED = tostring(aws_lexv2models_bot.supplier_simulator.id)`,
    ],
    [
      "a conditional changes the data source",
      `      SIMULATOR_ENABLED = var.simulator_enabled ? "true" : "false"`,
    ],
    [
      "a wrapper changes the data source",
      `      SIMULATOR_ENABLED = tostring(var.simulator_enabled && var.armed)`,
    ],
    [
      "the value is coerced through another expression",
      `      SIMULATOR_ENABLED = lower(tostring(var.simulator_enabled))`,
    ],
    [
      "a second assignment appears",
      `      SIMULATOR_ENABLED = tostring(var.simulator_enabled)
      SIMULATOR_ENABLED = "true"`,
    ],
    [
      // The exact hole the plan gate cannot close: the map still references
      // var.simulator_enabled, so every plan-level check passes, but the key
      // itself is driven by something else.
      "the key is rewired while the map still references var.simulator_enabled",
      `      SIMULATOR_ENABLED = tostring(var.other_flag)
      AUDIT_ECHO        = tostring(var.simulator_enabled)`,
    ],
  ])("fails when %s", (_label, variables) => {
    expect(simulatorEnabledAssignments(syntheticLambda(variables))).not.toEqual([
      EXPECTED_EXPRESSION,
    ]);
  });

  it("accepts the real expression when it is present in a synthetic file", () => {
    // Proves the negative cases above fail for the right reason: this same
    // matcher passes on the correct wiring.
    expect(
      simulatorEnabledAssignments(
        syntheticLambda(`      SIMULATOR_ENABLED = tostring(var.simulator_enabled)`),
      ),
    ).toEqual([EXPECTED_EXPRESSION]);
  });

  it("is not fooled by the key appearing outside the environment block", () => {
    const decoy = `variable "SIMULATOR_ENABLED" {}
# SIMULATOR_ENABLED = tostring(var.other_flag)
${syntheticLambda(`      SIMULATOR_ENABLED = tostring(var.simulator_enabled)`)}`;
    expect(simulatorEnabledAssignments(decoy)).toEqual([EXPECTED_EXPRESSION]);
  });
});

/**
 * Contact flow structure.
 *
 * Amazon Connect validates a flow at CreateContactFlow time, so a malformed or
 * unassociated flow is not caught until an apply is already half-done. These
 * checks are static and cheap; the association one is the invariant whose
 * absence caused InvalidContactFlowException on every apply.
 */
describe("connect contact flow", () => {
  const connect = tf("connect.tf");

  /**
   * The flow's actions, recovered from the jsonencode() call in connect.tf as
   * one text chunk each. Splitting on Identifier keeps each action's own
   * transitions with it, so a catch-all belonging to a different action cannot
   * satisfy the check below.
   *
   * `\bType` deliberately does not match ErrorType.
   */
  function flowActions(): { identifier: string; type: string; body: string }[] {
    return connect
      .split(/Identifier\s*=\s*"/)
      .slice(1)
      .map((chunk) => ({
        identifier: chunk.slice(0, chunk.indexOf('"')),
        type: /\bType\s*=\s*"([^"]+)"/.exec(chunk)?.[1] ?? "",
        body: chunk,
      }));
  }

  it("creates the Lex V2 association and orders the flow after it", () => {
    // Connect rejects a flow whose Lex alias is not associated with the
    // instance. Terraform must own that edge; a runbook step cannot.
    expect(connect).toContain('resource "awscc_connect_integration_association" "lex_bot"');
    expect(connect).toContain('integration_type = "LEX_BOT"');
    expect(connect).toContain("depends_on = [awscc_connect_integration_association.lex_bot]");
  });

  it("associates the same alias ARN the flow routes to", () => {
    // Two different ARNs here would associate one alias and route to another,
    // which fails exactly the same way and is far harder to see.
    const arnUses = connect.match(/local\.lex_bot_alias_arn/g) ?? [];
    expect(arnUses.length).toBe(2);
    expect(tf("lex.tf")).toMatch(/locals\s*\{[\s\S]*?lex_bot_alias_arn\s*=/);
  });

  it("parses the real actions, so the checks below are not vacuous", () => {
    const types = flowActions().map((a) => a.type);
    expect(types).toEqual([
      "UpdateFlowLoggingBehavior",
      "ConnectParticipantWithLexBot",
      "DisconnectParticipant",
    ]);
  });

  it("routes every NextAction to an identifier that exists", () => {
    const declared = new Set(flowActions().map((a) => a.identifier));
    expect(declared.size).toBeGreaterThan(0);
    for (const [, target] of connect.matchAll(/NextAction\s*=\s*"([^"]+)"/g)) {
      expect([...declared]).toContain(target);
    }
  });

  it("starts at a declared action", () => {
    const start = /StartAction\s*=\s*"([^"]+)"/.exec(connect)?.[1];
    expect(start).toBeTruthy();
    expect(flowActions().map((a) => a.identifier)).toContain(start);
  });

  it("defines NoMatchingError wherever the flow language requires it", () => {
    // UpdateFlowLoggingBehavior has no error surface and DisconnectParticipant
    // is terminal. Every other action must define the catch-all, or Connect
    // rejects the whole flow.
    const needsCatchAll = flowActions().filter(
      (a) => !["UpdateFlowLoggingBehavior", "DisconnectParticipant"].includes(a.type),
    );
    expect(needsCatchAll.length).toBeGreaterThan(0);
    for (const action of needsCatchAll) {
      expect(action.body).toContain("NoMatchingError");
    }
  });

  it("keeps the flow minimal and free of recording controls", () => {
    // Recording stays out until enable_call_recording is deliberately turned
    // on, and a recording action in the flow would contradict that.
    expect(connect).not.toContain("UpdateContactRecordingBehavior");
    expect(flowActions().length).toBeLessThanOrEqual(4);
  });

  it("never assigns a telephone number", () => {
    expect(connect).not.toContain("phone_number");
    expect(connect).not.toContain("aws_connect_phone_number");
  });
});

describe("workflow safety invariants", () => {
  const plan = repoFile(".github", "workflows", "terraform-plan.yml");
  const apply = repoFile(".github", "workflows", "terraform-apply.yml");
  /**
   * Workflow text with comment lines removed.
   *
   * These checks assert what a job actually does, so a comment that merely
   * mentions `environment:` must not satisfy or break them. Stripping
   * comments is enough here and avoids pulling in a YAML parser purely for
   * tests.
   */
  const withoutComments = (yaml: string) =>
    yaml
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

  const planJobBlock = (name: "validate" | "plan") => {
    const stripped = withoutComments(plan);
    const start = stripped.indexOf(`\n  ${name}:`);
    const nextJob = name === "validate" ? stripped.indexOf("\n  plan:") : stripped.length;
    return stripped.slice(start, nextJob);
  };

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

  it("binds the AWS plan job to the environment the role trust requires", () => {
    // The deploy role trusts `...:environment:aws-qualification`. A job with
    // no environment presents a `:ref:` subject instead and cannot assume the
    // role at all - this split is what makes deployment possible.
    const planJob = planJobBlock("plan");
    expect(planJob).toContain("environment:");
    expect(planJob).toContain("aws-qualification");
    expect(planJob).toContain("id-token: write");
  });

  it("keeps the PR-triggered validate job unable to reach AWS", () => {
    const validateJob = planJobBlock("validate");
    // No environment, no id-token, no role assumption: a pull request cannot
    // obtain a deployment credential even by accident.
    expect(validateJob).not.toContain("environment:");
    expect(validateJob).not.toContain("id-token");
    expect(validateJob).not.toContain("configure-aws-credentials");
    expect(validateJob).toContain("terraform validate");
  });

  it("runs the AWS plan only on manual dispatch from main", () => {
    const planJob = planJobBlock("plan");
    expect(planJob).toContain("github.event_name == 'workflow_dispatch'");
    expect(planJob).toContain("github.ref == 'refs/heads/main'");
    expect(planJob).toContain("vars.AWS_DEPLOY_ROLE_ARN != ''");
  });

  it("declares the backend as a partial config with no committed values", () => {
    const versions = tf("versions.tf");
    expect(versions).toContain('backend "s3" {}');
    // A bucket name or account id here would be committed configuration.
    expect(versions).not.toMatch(/bucket\s*=\s*"/);
    expect(versions).not.toMatch(/\b\d{12}\b/);
  });

  it("initializes the same remote state in both workflows", () => {
    for (const workflow of [plan, apply]) {
      expect(workflow).toContain('-backend-config="key=runtime/terraform.tfstate"');
      expect(workflow).toContain('-backend-config="use_lockfile=true"');
      expect(workflow).toContain('-backend-config="encrypt=true"');
      expect(workflow).toContain("secrets.TERRAFORM_STATE_BUCKET");
    }
  });

  it("defaults both runtime switches to false on every dispatch path", () => {
    // Neither a plan nor an apply may arm the supplier or attach a recording
    // configuration unless an operator consciously flips it.
    for (const workflow of [plan, apply]) {
      const inputs = workflow.slice(
        workflow.indexOf("workflow_dispatch:"),
        workflow.indexOf("permissions:"),
      );
      for (const name of ["simulator_enabled", "enable_call_recording"]) {
        expect(inputs).toContain(name);
      }
      expect(inputs).not.toContain("default: true");
      // realCallsEnabled is deliberately not exposed anywhere: the CALL-E
      // caller stays outside AWS.
      expect(workflow).not.toContain("realCallsEnabled");
    }
  });

  it("never exposes AWS identifiers as plain job-level variables", () => {
    // Masking is not retroactive. A job-level `vars.*` identifier is already
    // in the environment before any ::add-mask:: could run, so these must be
    // secrets, referenced as late as possible.
    for (const workflow of [plan, apply]) {
      expect(workflow).not.toContain("vars.AWS_ACCOUNT_ID");
      expect(workflow).not.toContain("vars.AWS_CONNECT_INSTANCE_ID");
      expect(workflow).toContain("secrets.AWS_ACCOUNT_ID");
      expect(workflow).toContain("secrets.AWS_CONNECT_INSTANCE_ID");
    }
  });

  it("keeps the credential-free stage free of AWS inputs entirely", () => {
    // fmt / init -backend=false / validate must run before any identifier or
    // credential enters the job.
    const beforePlan = plan.slice(0, plan.indexOf("Assume deployment role"));
    expect(beforePlan).toContain("terraform validate");
    expect(beforePlan).not.toContain("AWS_ACCOUNT_ID");
    expect(beforePlan).not.toContain("AWS_CONNECT_INSTANCE_ID");
  });

  it("says explicitly why no AWS plan ran when the deploy role is unconfigured", () => {
    expect(plan).toContain("AWS plan skipped");
    // The plan job is gated off entirely rather than running and reporting.
    expect(planJobBlock("plan")).toContain("vars.AWS_DEPLOY_ROLE_ARN != ''");
  });

  it("uses OIDC rather than static AWS keys", () => {
    for (const workflow of [plan, apply]) {
      expect(workflow).toContain("id-token: write");
      expect(workflow).not.toContain("AWS_SECRET_ACCESS_KEY");
      expect(workflow).not.toContain("aws_access_key_id");
    }
  });

  // -------------------------------------------------------------------------
  // The machine plan gate. Human plan review is necessary but not sufficient:
  // the properties below are mechanical, so a machine holds them.
  // -------------------------------------------------------------------------

  const stepBlock = (yaml: string, name: string) => {
    const stripped = withoutComments(yaml);
    const start = stripped.indexOf(`- name: ${name}`);
    expect(start).toBeGreaterThan(-1);
    const next = stripped.indexOf("\n      - name:", start + 1);
    return stripped.slice(start, next === -1 ? stripped.length : next);
  };

  it("gates both workflows on the same policy checker", () => {
    for (const workflow of [plan, apply]) {
      const stripped = withoutComments(workflow);
      expect(stripped).toContain("terraform show -json tfplan > tfplan.json");
      expect(stripped).toContain("scripts/terraform/assertQualificationPolicy.mjs");
      expect(stripped).toContain('--plan tfplan.json');
      expect(stripped).toContain('--mode "$PLAN_POLICY_MODE"');
    }
  });

  it("runs the gate before apply, never after", () => {
    const stripped = withoutComments(apply);
    const gate = stripped.indexOf("assertQualificationPolicy.mjs");
    const applyStep = stripped.indexOf("terraform apply");
    expect(gate).toBeGreaterThan(-1);
    expect(applyStep).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(applyStep);
  });

  it("cannot skip the gate with a step condition", () => {
    for (const workflow of [plan, apply]) {
      // `if:` on this step would let a plan through unchecked whenever the
      // condition happened to be false.
      expect(stepBlock(workflow, "Enforce the plan safety policy")).not.toMatch(/^\s+if:/m);
      expect(stepBlock(workflow, "Render the plan as JSON")).not.toMatch(/^\s+if:/m);
    }
  });

  it("fails closed instead of skipping when recording is requested", () => {
    for (const [workflow, step] of [
      [plan, "Select plan policy mode"],
      [apply, "Select apply policy mode"],
    ] as [string, string][]) {
      const block = stepBlock(workflow, step);
      expect(block).toContain('if [ "$RECORDING" != "false" ]');
      expect(block).toContain("exit 1");
      // false selects the initial policy, true selects qualification; anything
      // else is refused rather than defaulted. Recovery is a separate explicit
      // opt-in and still requires simulator=false.
      expect(block).toContain("MODE=initial");
      expect(block).toContain("MODE=qualification");
      expect(block).toContain("MODE=recovery");
      expect(block).toContain('if [ "$RECOVERY" = "true" ]');
    }
  });

  it("selects the policy mode before any AWS credential is requested", () => {
    for (const [workflow, step] of [
      [plan, "Select plan policy mode"],
      [apply, "Select apply policy mode"],
    ] as [string, string][]) {
      const stripped = withoutComments(workflow);
      expect(stripped.indexOf(`- name: ${step}`)).toBeLessThan(
        stripped.indexOf("configure-aws-credentials"),
      );
    }
  });

  it("never uploads the raw plan, only the sanitized policy report", () => {
    for (const workflow of [plan, apply]) {
      const stripped = withoutComments(workflow);
      expect(stripped).toContain("plan-policy-report.json");
      // tfplan and tfplan.json embed the account id, role ARNs and the
      // contact-flow body, so they must never leave the runner.
      expect(stripped).not.toMatch(/path:.*tfplan/);
      expect(stripped).not.toMatch(/path:.*plan\.txt/);
    }
  });

  it("verifies the deployed runtime read-only after apply", () => {
    const stripped = withoutComments(apply);
    const applyStep = stripped.indexOf("terraform apply");
    const verify = stripped.indexOf("scripts/qualification/verifyAwsRuntime.sh");
    expect(verify).toBeGreaterThan(applyStep);
    expect(stripped).toContain("--expect-recording false");
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
