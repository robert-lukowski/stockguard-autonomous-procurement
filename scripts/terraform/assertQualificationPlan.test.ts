import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ARCHITECTURE_A_RESOURCES,
  SIMULATOR_ARMING_ADDRESS,
  classifyActions,
  evaluatePlan,
  formatReport,
  readSimulatorFlag,
  // @ts-expect-error - plain .mjs module, deliberately dependency-free
} from "./assertQualificationPlan.mjs";

/**
 * The fixtures below are synthetic `terraform show -json` documents. They are
 * shaped after Terraform's documented plan representation - resource_changes
 * entries carrying mode/type/address and change.actions - so no Terraform
 * binary, provider schema or registry access is needed to test the policy.
 */

const LAMBDA_ENV = {
  SIMULATOR_ENABLED: "false",
  ALLOWED_LEX_BOT_IDS: "ABCDEFGHIJ",
  ALLOWED_LEX_ALIAS_NAMES: "qualification",
  ALLOWED_LEX_LOCALES: "en_US",
  QUALIFICATION_SKU: "CF-220",
  QUALIFICATION_QUANTITY: "8",
  QUALIFICATION_REQUIRED_BY: "2026-08-28T12:00:00+02:00",
};

function lambdaAttributes(overrides: Record<string, unknown> = {}) {
  return {
    function_name: "stockguard-qualification-supplier-simulator",
    handler: "index.lexFulfillment",
    runtime: "nodejs22.x",
    timeout: 10,
    memory_size: 256,
    reserved_concurrent_executions: 2,
    role: "arn:aws:iam::000000000000:role/stockguard-qualification-supplier-simulator",
    source_code_hash: "hash-a",
    environment: [{ variables: { ...LAMBDA_ENV } }],
    ...overrides,
  };
}

function typeOf(address: string): string {
  return address.split(".")[0];
}

function change(address: string, actions: string[], after: unknown = {}, before: unknown = null) {
  return {
    address,
    mode: "managed",
    type: typeOf(address),
    name: address.split(".")[1],
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: { actions, before, after, after_unknown: {} },
  };
}

/** The plan a first, clean `simulator_enabled=false` deployment produces. */
function initialCreatePlan(extra: unknown[] = []) {
  return {
    format_version: "1.2",
    terraform_version: "1.14.5",
    variables: {
      simulator_enabled: { value: false },
      enable_call_recording: { value: false },
    },
    resource_changes: [
      ...ARCHITECTURE_A_RESOURCES.map((address: string) =>
        change(address, ["create"], address === SIMULATOR_ARMING_ADDRESS ? lambdaAttributes() : {}),
      ),
      ...extra,
    ],
  };
}

/** The plan that arms an already-deployed runtime and changes nothing else. */
function qualificationArmingPlan(extra: unknown[] = []) {
  return {
    format_version: "1.2",
    terraform_version: "1.14.5",
    variables: {
      simulator_enabled: { value: true },
      enable_call_recording: { value: false },
    },
    resource_changes: [
      ...ARCHITECTURE_A_RESOURCES.map((address: string) => {
        if (address !== SIMULATOR_ARMING_ADDRESS) return change(address, ["no-op"], {}, {});
        return change(
          address,
          ["update"],
          lambdaAttributes({ environment: [{ variables: { ...LAMBDA_ENV, SIMULATOR_ENABLED: "true" } }] }),
          lambdaAttributes(),
        );
      }),
      ...extra,
    ],
  };
}

function codes(plan: unknown, mode: string): string[] {
  return evaluatePlan(plan, { mode }).violations.map((v: { code: string }) => v.code);
}

// ---------------------------------------------------------------------------

describe("architecture A resource set", () => {
  it("matches the resources actually declared in the Terraform configuration", () => {
    // Re-derived from the .tf files on every run, so the allowlist cannot drift
    // away from the configuration it is supposed to constrain, and so this test
    // fails the moment somebody adds a resource without revisiting the policy.
    const tfDir = join(__dirname, "..", "..", "infrastructure", "terraform");
    const hcl = readdirSync(tfDir)
      .filter((f) => f.endsWith(".tf"))
      .map((f) => readFileSync(join(tfDir, f), "utf8"))
      .join("\n");

    const declared = [...hcl.matchAll(/^resource "([^"]+)" "([^"]+)" \{\n([\s\S]*?)\n\}$/gm)];
    expect(declared.length).toBeGreaterThan(0);

    const ungated = declared
      .filter((m) => !m[3].includes("var.enable_call_recording ? 1 : 0"))
      .map((m) => `${m[1]}.${m[2]}`);
    const recordingGated = declared
      .filter((m) => m[3].includes("var.enable_call_recording ? 1 : 0"))
      .map((m) => `${m[1]}.${m[2]}`);

    expect([...ungated].sort()).toEqual([...ARCHITECTURE_A_RESOURCES].sort());
    // Every recording resource must be outside the allowlist, or the gate
    // would wave call recording through.
    for (const address of recordingGated) {
      expect(ARCHITECTURE_A_RESOURCES).not.toContain(address);
    }
    expect(recordingGated.length).toBeGreaterThan(0);
  });

  it("cannot reach Terraform or AWS even if asked to", () => {
    const source = readFileSync(join(__dirname, "assertQualificationPlan.mjs"), "utf8");
    for (const forbidden of [
      "child_process",
      "node:child_process",
      "execSync",
      "spawn",
      "@aws-sdk",
      "aws-sdk",
      "node:http",
      "node:https",
      "fetch(",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    // The only imports are filesystem ones.
    const imports = [...source.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["node:fs"]);
  });
});

describe("action classification", () => {
  it("recognises Terraform's documented action lists", () => {
    expect(classifyActions(["create"])).toBe("create");
    expect(classifyActions(["no-op"])).toBe("no-op");
    expect(classifyActions(["read"])).toBe("read");
    expect(classifyActions(["update"])).toBe("update");
    expect(classifyActions(["delete"])).toBe("delete");
    // Both orderings mean replacement; create_before_destroy produces the second.
    expect(classifyActions(["delete", "create"])).toBe("replace");
    expect(classifyActions(["create", "delete"])).toBe("replace");
    expect(classifyActions(["forget"])).toBe("forget");
  });

  it("fails closed on an action it does not recognise", () => {
    expect(classifyActions(["teleport"])).toBe("unrecognized:teleport");
    expect(classifyActions([])).toBe("unrecognized:empty");
    const plan = initialCreatePlan([change("aws_lambda_alias.x", ["teleport"])]);
    expect(evaluatePlan(plan, { mode: "initial" }).ok).toBe(false);
  });
});

describe("initial deployment policy - accepted plans", () => {
  it("accepts a create-only plan for exactly the Architecture A resource set", () => {
    const result = evaluatePlan(initialCreatePlan(), { mode: "initial" });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.counts.create).toBe(ARCHITECTURE_A_RESOURCES.length);
    expect(result.destructive).toBe(0);
    expect(result.unexpected).toEqual([]);
    expect(result.expectedMissing).toEqual([]);
    expect(result.simulatorEnabled).toBe("false");
    expect(result.recordingResourcesPresent).toBe(false);
  });

  it("does not fail policy on data-source reads", () => {
    const reads = [
      {
        address: "data.aws_caller_identity.current",
        mode: "data",
        type: "aws_caller_identity",
        name: "current",
        change: { actions: ["read"], before: null, after: {}, after_unknown: {} },
      },
      {
        address: "data.archive_file.supplier_simulator",
        mode: "data",
        type: "archive_file",
        name: "supplier_simulator",
        change: { actions: ["read"], before: null, after: {}, after_unknown: {} },
      },
      {
        address: "data.aws_iam_policy_document.lex_assume",
        mode: "data",
        type: "aws_iam_policy_document",
        name: "lex_assume",
        change: { actions: ["no-op"], before: {}, after: {}, after_unknown: {} },
      },
    ];
    const result = evaluatePlan(initialCreatePlan(reads), { mode: "initial" });
    expect(result.violations).toEqual([]);
    expect(result.counts.read).toBe(2);
  });

  it("accepts an all-no-op re-plan of an already applied deployment", () => {
    const plan = initialCreatePlan();
    plan.resource_changes = plan.resource_changes.map((rc: Record<string, unknown>) => ({
      ...rc,
      change: { ...(rc.change as Record<string, unknown>), actions: ["no-op"] },
    }));
    expect(evaluatePlan(plan, { mode: "initial" }).ok).toBe(true);
  });

  it("judges structure, not wording", () => {
    // Every forbidden noun appears in this plan as free text. None of it is in
    // a position the policy reads, so the plan must still pass. A grep-based
    // gate would reject this.
    const plan = initialCreatePlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: { after: Record<string, unknown> } };
    lambda.change.after.description =
      "delete replace destroy aws_connect_instance phone_number dynamodb secretsmanager kms_key sfn_state_machine CALL_RECORDINGS SIMULATOR_ENABLED=true";
    expect(evaluatePlan(plan, { mode: "initial" }).ok).toBe(true);
  });
});

describe("initial deployment policy - refused plans", () => {
  it("refuses a delete, even of an allowlisted resource", () => {
    const plan = initialCreatePlan();
    plan.resource_changes[0].change.actions = ["delete"];
    expect(codes(plan, "initial")).toContain("delete-action");
  });

  it("refuses a replacement in either ordering", () => {
    for (const actions of [["delete", "create"], ["create", "delete"]]) {
      const plan = initialCreatePlan();
      plan.resource_changes[0].change.actions = actions;
      expect(codes(plan, "initial")).toContain("replace-action");
    }
  });

  it("refuses an update to an existing managed resource", () => {
    const plan = initialCreatePlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: Record<string, unknown> };
    lambda.change.actions = ["update"];
    lambda.change.before = lambdaAttributes();
    expect(codes(plan, "initial")).toContain("update-action");
  });

  it("refuses a resource outside the allowlist", () => {
    const plan = initialCreatePlan([change("aws_lambda_alias.shadow", ["create"])]);
    const result = evaluatePlan(plan, { mode: "initial" });
    expect(result.violations.map((v: { code: string }) => v.code)).toContain("unexpected-resource");
    expect(result.unexpected).toEqual(["aws_lambda_alias.shadow"]);
  });

  it("refuses IAM outside the qualification runtime with a specific reason", () => {
    const plan = initialCreatePlan([change("aws_iam_role.extra_admin", ["create"])]);
    expect(codes(plan, "initial")).toContain("unexpected-iam");
  });

  it("refuses a resource inside an unexpected module", () => {
    const nested = change("module.extra.aws_lambda_function.other", ["create"]);
    nested.type = "aws_lambda_function";
    expect(codes(initialCreatePlan([nested]), "initial")).toContain("unexpected-resource");
  });

  it.each([
    ["aws_connect_instance.new", "forbidden:connect-instance"],
    ["aws_connect_phone_number.claimed", "forbidden:phone-number"],
    ["aws_connect_phone_number_contact_flow_association.wired", "forbidden:phone-number"],
    ["aws_connect_instance_storage_config.call_recordings", "forbidden:connect-storage-config"],
    ["aws_s3_bucket.recordings", "forbidden:recording-storage"],
    ["aws_s3_bucket_policy.recordings", "forbidden:recording-storage"],
    ["aws_dynamodb_table.runs", "forbidden:dynamodb"],
    ["aws_secretsmanager_secret.calle_key", "forbidden:secrets-manager"],
    ["aws_kms_key.recordings", "forbidden:kms-customer-key"],
    ["aws_sfn_state_machine.orchestrator", "forbidden:step-functions"],
    ["aws_apigatewayv2_api.caller", "forbidden:deployed-caller"],
    ["aws_lambda_function_url.caller", "forbidden:deployed-caller"],
    ["aws_sns_topic.calls", "forbidden:deployed-caller"],
  ])("refuses %s", (address, expectedCode) => {
    const plan = initialCreatePlan([change(address, ["create"])]);
    const result = evaluatePlan(plan, { mode: "initial" });
    expect(result.violations.map((v: { code: string }) => v.code)).toContain(expectedCode);
    expect(result.ok).toBe(false);
  });

  it("flags recording resources in the report summary", () => {
    const plan = initialCreatePlan([
      change("aws_s3_bucket.recordings", ["create"]),
      change("aws_connect_instance_storage_config.call_recordings", ["create"]),
    ]);
    expect(evaluatePlan(plan, { mode: "initial" }).recordingResourcesPresent).toBe(true);
  });

  it("refuses recording even when it is the declared intent", () => {
    const plan = initialCreatePlan();
    plan.variables.enable_call_recording = { value: true };
    expect(codes(plan, "initial")).toContain("recording-enabled");
    expect(codes(plan, "qualification")).toContain("recording-enabled");
  });

  it("refuses SIMULATOR_ENABLED planned as true", () => {
    const plan = initialCreatePlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: { after: Record<string, unknown> } };
    lambda.change.after.environment = [{ variables: { ...LAMBDA_ENV, SIMULATOR_ENABLED: "true" } }];
    const result = evaluatePlan(plan, { mode: "initial" });
    expect(result.violations.map((v: { code: string }) => v.code)).toContain("simulator-flag-mismatch");
    expect(result.simulatorEnabled).toBe("true");
  });

  it("refuses a plan whose declared simulator_enabled is true", () => {
    const plan = initialCreatePlan();
    plan.variables.simulator_enabled = { value: true };
    expect(codes(plan, "initial")).toContain("simulator-armed");
  });

  it("fails closed when SIMULATOR_ENABLED is unknown rather than assuming false", () => {
    const plan = initialCreatePlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: Record<string, unknown> };
    (lambda.change.after as Record<string, unknown>).environment = [
      { variables: { ...LAMBDA_ENV, SIMULATOR_ENABLED: null } },
    ];
    lambda.change.after_unknown = { environment: [{ variables: { SIMULATOR_ENABLED: true } }] };
    const result = evaluatePlan(plan, { mode: "initial" });
    expect(result.violations.map((v: { code: string }) => v.code)).toContain("simulator-flag-unresolved");
    expect(result.simulatorEnabled).toBe("unknown");
  });

  it("fails closed when the environment block omits the SIMULATOR_ENABLED key", () => {
    // Distinct branch from a missing environment block: the map exists and is
    // fully known, but the key the policy depends on is simply not there.
    // Treating that as "false" would be an assumption, not an observation.
    const plan = initialCreatePlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: { after: Record<string, unknown> } };
    const withoutFlag: Record<string, string> = { ...LAMBDA_ENV };
    delete withoutFlag.SIMULATOR_ENABLED;
    lambda.change.after.environment = [{ variables: withoutFlag }];
    const result = evaluatePlan(plan, { mode: "initial" });
    expect(result.violations.map((v: { code: string }) => v.code)).toContain("simulator-flag-unresolved");
    expect(result.simulatorEnabled).toBe("absent");
  });

  it("fails closed when the environment block is missing entirely", () => {
    const plan = initialCreatePlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: { after: Record<string, unknown> } };
    delete lambda.change.after.environment;
    expect(codes(plan, "initial")).toContain("simulator-flag-unresolved");
  });

  it("refuses an unbounded or oversized Lambda concurrency", () => {
    for (const reserved of [null, undefined, 500]) {
      const plan = initialCreatePlan();
      const lambda = plan.resource_changes.find(
        (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
      ) as { change: { after: Record<string, unknown> } };
      lambda.change.after = lambdaAttributes({ reserved_concurrent_executions: reserved });
      expect(codes(plan, "initial")).toContain("lambda-concurrency");
    }
  });

  it("refuses an unexpected Lambda runtime", () => {
    const plan = initialCreatePlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: { after: Record<string, unknown> } };
    lambda.change.after = lambdaAttributes({ runtime: "nodejs18.x" });
    expect(codes(plan, "initial")).toContain("lambda-runtime");
  });

  it("refuses a document that is not a terraform plan", () => {
    expect(evaluatePlan({ hello: "world" }, { mode: "initial" }).ok).toBe(false);
    expect(evaluatePlan(null, { mode: "initial" }).ok).toBe(false);
    expect(codes({ resource_changes: [] }, "sabotage")).toContain("bad-mode");
  });
});

describe("qualification policy - arming an existing runtime", () => {
  it("accepts exactly the simulator arming change", () => {
    const result = evaluatePlan(qualificationArmingPlan(), { mode: "qualification" });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.counts.update).toBe(1);
    expect(result.simulatorEnabled).toBe("true");
    expect(result.destructive).toBe(0);
  });

  it("refuses an update to any other resource", () => {
    const plan = qualificationArmingPlan();
    const flow = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === "aws_connect_contact_flow.supplier_simulator",
    ) as { change: Record<string, unknown> };
    flow.change.actions = ["update"];
    expect(codes(plan, "qualification")).toContain("update-action");
  });

  it("refuses a create, because arming presupposes a deployed runtime", () => {
    const plan = qualificationArmingPlan();
    const bot = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === "aws_lexv2models_bot.supplier_simulator",
    ) as { change: Record<string, unknown> };
    bot.change.actions = ["create"];
    expect(codes(plan, "qualification")).toContain("create-in-qualification");
  });

  it("refuses arming that also changes a safety-critical Lambda attribute", () => {
    for (const [attribute, value] of [
      ["reserved_concurrent_executions", 50],
      ["runtime", "nodejs22.x"],
      ["role", "arn:aws:iam::000000000000:role/something-else"],
      ["timeout", 600],
      ["memory_size", 4096],
    ] as [string, unknown][]) {
      const plan = qualificationArmingPlan();
      const lambda = plan.resource_changes.find(
        (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
      ) as { change: { after: Record<string, unknown> } };
      lambda.change.after = lambdaAttributes({
        environment: [{ variables: { ...LAMBDA_ENV, SIMULATOR_ENABLED: "true" } }],
        [attribute]: value,
      });
      const found = codes(plan, "qualification");
      // runtime is set to the same value, so only a genuine change is a finding.
      if (attribute === "runtime") expect(found).toEqual([]);
      else expect(found).toContain("lambda-attribute-change");
    }
  });

  it("refuses arming that also rewrites another environment variable", () => {
    const plan = qualificationArmingPlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: { after: Record<string, unknown> } };
    lambda.change.after = lambdaAttributes({
      environment: [
        {
          variables: {
            ...LAMBDA_ENV,
            SIMULATOR_ENABLED: "true",
            // Widening the alias guard would let an unreviewed alias drive the
            // supplier. It is not part of arming.
            ALLOWED_LEX_ALIAS_NAMES: "qualification,TestBotAlias",
          },
        },
      ],
    });
    expect(codes(plan, "qualification")).toContain("lambda-env-change");
  });

  it("tolerates a rebuilt bundle but reports it", () => {
    const plan = qualificationArmingPlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: { after: Record<string, unknown> } };
    lambda.change.after = lambdaAttributes({
      environment: [{ variables: { ...LAMBDA_ENV, SIMULATOR_ENABLED: "true" } }],
      source_code_hash: "hash-b",
    });
    const result = evaluatePlan(plan, { mode: "qualification" });
    expect(result.ok).toBe(true);
    expect(result.lambdaCodeChanged).toBe(true);
  });

  it("refuses a destructive change just as the initial policy does", () => {
    const plan = qualificationArmingPlan([change("aws_dynamodb_table.runs", ["create"])]);
    plan.resource_changes[0].change.actions = ["delete", "create"];
    const found = codes(plan, "qualification");
    expect(found).toContain("replace-action");
    expect(found).toContain("forbidden:dynamodb");
  });

  it("refuses a plan that arms nothing", () => {
    const plan = qualificationArmingPlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: Record<string, unknown> };
    lambda.change.actions = ["no-op"];
    expect(codes(plan, "qualification")).toContain("nothing-to-arm");
  });

  it("refuses SIMULATOR_ENABLED false under the qualification policy", () => {
    const plan = qualificationArmingPlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: { after: Record<string, unknown> } };
    lambda.change.after = lambdaAttributes();
    expect(codes(plan, "qualification")).toContain("simulator-flag-mismatch");
  });
});

describe("report output", () => {
  it("summarises a passing plan without leaking plan values", () => {
    const plan = initialCreatePlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: { after: Record<string, unknown> } };
    // Values a plan really does carry, none of which may reach the report.
    lambda.change.after.role = "arn:aws:iam::123456789012:role/secret-role";
    lambda.change.after.description = "+14155550123";

    const text = formatReport(evaluatePlan(plan, { mode: "initial" }));
    expect(text).toContain("Terraform plan policy: PASS");
    expect(text).toContain("policy mode                  initial");
    expect(text).toContain("simulator armed              no");
    expect(text).toContain("recording resources present  no");
    expect(text).toContain("delete / replace             0");
    expect(text).not.toContain("123456789012");
    expect(text).not.toContain("+1415");
  });

  it("names every violation on a failing plan", () => {
    const plan = initialCreatePlan([change("aws_dynamodb_table.runs", ["create"])]);
    const text = formatReport(evaluatePlan(plan, { mode: "initial" }));
    expect(text).toContain("Terraform plan policy: FAIL");
    expect(text).toContain("Refusing this plan.");
    expect(text).toContain("[forbidden:dynamodb] aws_dynamodb_table.runs");
  });
});

describe("simulator flag extraction", () => {
  it("reads the value out of Terraform's block encoding", () => {
    expect(readSimulatorFlag({ after: { environment: [{ variables: { SIMULATOR_ENABLED: "false" } }] } })).toEqual({
      state: "known",
      value: "false",
    });
    expect(readSimulatorFlag({ after: { environment: { variables: { SIMULATOR_ENABLED: "true" } } } })).toEqual({
      state: "known",
      value: "true",
    });
    expect(readSimulatorFlag({ after: {} })).toEqual({ state: "absent", value: null });
    expect(
      readSimulatorFlag({ after: { environment: [{}] }, after_unknown: { environment: [{ variables: true }] } }),
    ).toEqual({ state: "unknown", value: null });
  });
});
