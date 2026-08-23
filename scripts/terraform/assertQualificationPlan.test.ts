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
  normalizeReference,
  readEnvironmentReferences,
  canonicalBoolean,
  FORGETTABLE_STATE_ADDRESS,
  REPLACEABLE_BUILD_ADDRESS,
  REPLACEABLE_SNAPSHOT_ADDRESS,
  REPOINTABLE_ALIAS_ADDRESS,
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

/**
 * The plan that disarms an already-armed runtime and changes nothing else.
 * This is the rollback path: `simulator_enabled=false` selects the INITIAL
 * policy, and disarming is a genuine `update` to a resource that exists.
 */
function disarmPlan(overrides: Record<string, unknown> = {}, extra: unknown[] = []) {
  return {
    format_version: "1.2",
    terraform_version: "1.14.5",
    variables: {
      simulator_enabled: { value: false },
      enable_call_recording: { value: false },
    },
    resource_changes: [
      ...ARCHITECTURE_A_RESOURCES.map((address: string) => {
        if (address !== SIMULATOR_ARMING_ADDRESS) return change(address, ["no-op"], {}, {});
        return change(
          address,
          ["update"],
          lambdaAttributes(overrides),
          // Prior state: armed.
          lambdaAttributes({ environment: [{ variables: { ...LAMBDA_ENV, SIMULATOR_ENABLED: "true" } }] }),
        );
      }),
      ...extra,
    ],
  };
}

function details(plan: unknown, mode: string): string {
  return evaluatePlan(plan, { mode })
    .violations.map((v: { detail: string }) => v.detail)
    .join("\n");
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
    // Any resource except the simulator Lambda, whose SIMULATOR_ENABLED
    // transition is the single update either policy permits.
    for (const address of [
      "aws_connect_contact_flow.supplier_simulator",
      "aws_lexv2models_bot.supplier_simulator",
      "aws_iam_role.lex_bot",
      "aws_lambda_permission.lex_invoke",
    ]) {
      const plan = initialCreatePlan();
      const target = plan.resource_changes.find(
        (rc: { address: string }) => rc.address === address,
      ) as { change: Record<string, unknown> };
      target.change.actions = ["update"];
      target.change.before = {};
      expect(codes(plan, "initial")).toContain("update-action");
    }
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

describe("initial policy - disarming after a qualification", () => {
  it("accepts exactly the disarming change", () => {
    // The rollback in the runbook runs through this path. Without it the
    // operator could not disarm through the gated workflow at all.
    const result = evaluatePlan(disarmPlan(), { mode: "initial" });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.counts.update).toBe(1);
    expect(result.counts.create ?? 0).toBe(0);
    expect(result.destructive).toBe(0);
    expect(result.simulatorEnabled).toBe("false");
    expect(result.simulatorFlagChange).toBe("true -> false");
  });

  it("refuses an update that is not a real transition", () => {
    // Already "false" before and after: the update must be for some other
    // reason, so it is not the change this policy permits.
    const plan = disarmPlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: Record<string, unknown> };
    lambda.change.before = lambdaAttributes();
    expect(codes(plan, "initial")).toContain("simulator-flag-transition");
  });

  it("refuses arming through the initial policy", () => {
    const plan = disarmPlan({
      environment: [{ variables: { ...LAMBDA_ENV, SIMULATOR_ENABLED: "true" } }],
    });
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: Record<string, unknown> };
    lambda.change.before = lambdaAttributes();
    const found = codes(plan, "initial");
    expect(found).toContain("simulator-flag-mismatch");
  });

  it("refuses disarming that also changes a safety-critical attribute", () => {
    for (const [attribute, value] of [
      ["reserved_concurrent_executions", 50],
      ["role", "arn:aws:iam::000000000000:role/something-else"],
      ["timeout", 600],
      ["handler", "index.somethingElse"],
    ] as [string, unknown][]) {
      expect(codes(disarmPlan({ [attribute]: value }), "initial")).toContain(
        "lambda-attribute-change",
      );
    }
  });

  it("refuses disarming that also rewrites another environment variable", () => {
    const plan = disarmPlan({
      environment: [
        {
          variables: {
            ...LAMBDA_ENV,
            SIMULATOR_ENABLED: "false",
            ALLOWED_LEX_ALIAS_NAMES: "qualification,TestBotAlias",
          },
        },
      ],
    });
    expect(codes(plan, "initial")).toContain("lambda-env-change");
  });

  it("refuses disarming alongside an update to any other resource", () => {
    const plan = disarmPlan();
    const flow = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === "aws_connect_contact_flow.supplier_simulator",
    ) as { change: Record<string, unknown> };
    flow.change.actions = ["update"];
    expect(codes(plan, "initial")).toContain("update-action");
  });

  it("refuses disarming alongside anything destructive or unexpected", () => {
    const plan = disarmPlan({}, [change("aws_dynamodb_table.runs", ["create"])]);
    plan.resource_changes[0].change.actions = ["delete"];
    const found = codes(plan, "initial");
    expect(found).toContain("delete-action");
    expect(found).toContain("forbidden:dynamodb");
  });

  it("fails closed when the prior SIMULATOR_ENABLED cannot be resolved", () => {
    const plan = disarmPlan();
    const lambda = plan.resource_changes.find(
      (rc: { address: string }) => rc.address === SIMULATOR_ARMING_ADDRESS,
    ) as { change: Record<string, unknown> };
    lambda.change.before = lambdaAttributes({ environment: undefined });
    expect(codes(plan, "initial")).toContain("simulator-flag-unresolved");
  });

  it("still accepts a plain first deployment, which has nothing to disarm", () => {
    // Initial mode serves both purposes; adding the disarm path must not make
    // a create-only plan require an update.
    expect(evaluatePlan(initialCreatePlan(), { mode: "initial" }).ok).toBe(true);
  });

  it("refuses a disarming transition under the qualification policy", () => {
    // Qualification exists only to arm; the reverse direction is not its job.
    const plan = disarmPlan();
    plan.variables.simulator_enabled = { value: true };
    const found = codes(plan, "qualification");
    expect(found).toContain("simulator-flag-mismatch");
    expect(found).toContain("simulator-flag-transition");
  });
});

describe("the unknown-environment shape a real create plan produces", () => {
  /**
   * Captured from Terraform 1.14.5 + hashicorp/aws on run 32573490266, the
   * first real plan against AWS. On a create the provider reports the WHOLE
   * environment variables map as unknown, because ALLOWED_LEX_BOT_IDS
   * references a bot that does not exist yet - there is no per-key marking to
   * read. The earlier fixtures assumed per-key marking, which is exactly why
   * the suite passed while the real plan was refused.
   */
  const REAL_REFERENCES = [
    "var.simulator_enabled",
    "aws_lexv2models_bot.supplier_simulator.id",
    "aws_lexv2models_bot.supplier_simulator",
    "local.lex_alias_name",
    "local.lex_locale_id",
    "var.qualification_sku",
    "var.qualification_quantity",
    "var.qualification_required_by",
  ];

  function configurationSection(references: string[] | null, address = SIMULATOR_ARMING_ADDRESS) {
    return {
      root_module: {
        resources: [
          {
            address,
            mode: "managed",
            type: "aws_lambda_function",
            name: "supplier_simulator",
            expressions:
              references === null
                ? { function_name: { constant_value: "x" } }
                : {
                    function_name: { constant_value: "x" },
                    // Terraform collapses the whole object constructor into a
                    // single references array; there is no per-key data.
                    environment: [{ variables: { references } }],
                  },
          },
        ],
      },
    };
  }

  function realCreatePlan(options: {
    declared?: unknown;
    references?: string[] | null;
    configuration?: unknown;
    address?: string;
  } = {}) {
    const plan = initialCreatePlan() as Record<string, unknown>;
    const lambda = (plan.resource_changes as { address: string; change: Record<string, unknown> }[]).find(
      (rc) => rc.address === SIMULATOR_ARMING_ADDRESS,
    )!;
    // The observed shape: variables present but null, marked wholly unknown.
    (lambda.change.after as Record<string, unknown>).environment = [{ variables: null }];
    lambda.change.after_unknown = { environment: [{ variables: true }] };

    (plan.variables as Record<string, unknown>).simulator_enabled = {
      value: "declared" in options ? options.declared : false,
    };
    plan.configuration =
      "configuration" in options
        ? options.configuration
        : configurationSection(
            options.references === undefined ? REAL_REFERENCES : options.references,
            options.address,
          );
    return plan;
  }

  it("accepts the STRING form TF_VAR_ actually supplies", () => {
    // Verified against Terraform 1.14.5: a `bool` variable passed through
    // TF_VAR_simulator_enabled - which is how both workflows pass it - is
    // recorded in the plan JSON as the string "false", never a boolean.
    // Run 32575497267 was refused because this fixture used a boolean.
    const plan = realCreatePlan({ declared: "false" });
    expect(plan.variables.simulator_enabled).toEqual({ value: "false" });

    const result = evaluatePlan(plan, { mode: "initial" });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.simulatorEnabled).toBe("false");
    expect(result.simulatorFlagSource).toBe("declared input + configuration");
  });

  it("accepts the string form for arming too", () => {
    const plan = realCreatePlan({ declared: "true" });
    // A create planned as armed is refused by the initial policy, correctly,
    // but the declared input must still be RECOGNISED rather than rejected as
    // an unparseable form.
    const found = codes(plan, "initial");
    // Recognised, and therefore refused by the declared-input guard rather
    // than dismissed as an unparseable form.
    expect(found).toContain("simulator-armed");
    expect(details(plan, "initial")).not.toContain("not one of the four accepted forms");
  });

  it.each([
    ["TRUE", "TRUE"],
    ["True", "True"],
    ["yes", "yes"],
    ["1", "1"],
    ["0", "0"],
    ["", ""],
    [" true (padded)", " true"],
    ["the number 1", 1],
    ["the number 0", 0],
    ["null", null],
    ["an object", { value: false }],
  ])("still fails closed on %s", (_label, declared) => {
    const plan = realCreatePlan({ declared });
    const result = evaluatePlan(plan, { mode: "initial" });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v: { code: string }) => v.code)).toContain("simulator-flag-unresolved");
    expect(details(plan, "initial")).toContain("not one of the four accepted forms");
  });

  it("names corroboration as refused rather than reporting a bare planned value", () => {
    const plan = realCreatePlan({ declared: "yes" });
    const result = evaluatePlan(plan, { mode: "initial" });
    expect(result.simulatorFlagSource).toBe("planned value (unknown); corroboration refused");
    const text = formatReport(result);
    expect(text).toContain("corroboration refused");
    expect(details(plan, "initial")).toContain("That corroboration was REFUSED");
  });

  it("says corroboration is not offered at all on an update", () => {
    const plan = disarmPlan() as Record<string, unknown>;
    const lambda = (plan.resource_changes as { address: string; change: Record<string, unknown> }[]).find(
      (rc) => rc.address === SIMULATOR_ARMING_ADDRESS,
    )!;
    (lambda.change.after as Record<string, unknown>).environment = [{ variables: null }];
    lambda.change.after_unknown = { environment: [{ variables: true }] };
    expect(details(plan, "initial")).toContain("corroboration is deliberately not offered");
  });

  it("reads the flag as unknown from the planned value alone", () => {
    // The underlying extractor must still report the truth; only the policy
    // above it is allowed to corroborate.
    const plan = realCreatePlan();
    const lambda = (plan.resource_changes as { address: string; change: unknown }[]).find(
      (rc) => rc.address === SIMULATOR_ARMING_ADDRESS,
    )!;
    expect(readSimulatorFlag(lambda.change)).toEqual({ state: "unknown", value: null });
  });

  it("accepts the plan once the declared input and configuration corroborate it", () => {
    const result = evaluatePlan(realCreatePlan(), { mode: "initial" });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.simulatorEnabled).toBe("false");
    expect(result.simulatorFlagSource).toBe("declared input + configuration");
    expect(result.counts.create).toBe(ARCHITECTURE_A_RESOURCES.length);
  });

  it("still prefers the planned value when it is readable", () => {
    const result = evaluatePlan(initialCreatePlan(), { mode: "initial" });
    expect(result.ok).toBe(true);
    expect(result.simulatorFlagSource).toBe("planned value");
  });

  it("does NOT blindly assume false: a declared true is refused", () => {
    // The mutation this whole mechanism exists to prevent. The planned value is
    // unknown and the configuration is intact, so the only thing standing
    // between this plan and a PASS is the declared input.
    const plan = realCreatePlan({ declared: true });
    const result = evaluatePlan(plan, { mode: "initial" });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v: { code: string }) => v.code)).toContain("simulator-flag-unresolved");
    // Refused for the right reason: the declared input contradicts the mode,
    // so it cannot corroborate anything.
    expect(details(plan, "initial")).toContain("simulator_enabled=true");
    expect(result.simulatorEnabled).not.toBe("false");
  });

  it.each([
    ["a missing declared input", { declared: undefined }],
    ["a declared input that is an unrecognised string", { declared: "maybe" }],
  ])("fails closed on %s", (_label, options) => {
    const found = codes(realCreatePlan(options), "initial");
    expect(found).toContain("simulator-flag-unresolved");
  });

  it.each([
    ["no configuration section at all", { configuration: undefined }],
    ["a configuration with no root module", { configuration: {} }],
    ["the Lambda absent from the configuration", { address: "aws_lambda_function.something_else" }],
    ["no environment expression", { references: null }],
    ["no references recorded", { configuration: { root_module: { resources: [{ address: SIMULATOR_ARMING_ADDRESS, expressions: { environment: [{ variables: {} }] } }] } } }],
  ])("fails closed on %s", (_label, options) => {
    const result = evaluatePlan(realCreatePlan(options), { mode: "initial" });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v: { code: string }) => v.code)).toContain("simulator-flag-unresolved");
  });

  it("fails closed when the map no longer references var.simulator_enabled", () => {
    // Rewired to a different variable: the declared input would still say
    // false, but it would no longer be what drives the Lambda.
    const rewired = REAL_REFERENCES.filter((r) => r !== "var.simulator_enabled").concat("var.some_other_flag");
    const plan = realCreatePlan({ references: rewired });
    expect(evaluatePlan(plan, { mode: "initial" }).ok).toBe(false);
    expect(details(plan, "initial")).toContain("no longer references var.simulator_enabled");
  });

  it("fails closed when the map references something outside Architecture A", () => {
    const injected = [...REAL_REFERENCES, "aws_ssm_parameter.injected.value"];
    const plan = realCreatePlan({ references: injected });
    expect(evaluatePlan(plan, { mode: "initial" }).ok).toBe(false);
    expect(details(plan, "initial")).toContain("aws_ssm_parameter.injected");
  });

  it("does not offer the fallback on an update, where the values are concrete", () => {
    // Arming and disarming must keep reading the real planned value, so the
    // transition checks cannot be satisfied by the declared input.
    const plan = disarmPlan() as Record<string, unknown>;
    const lambda = (plan.resource_changes as { address: string; change: Record<string, unknown> }[]).find(
      (rc) => rc.address === SIMULATOR_ARMING_ADDRESS,
    )!;
    (lambda.change.after as Record<string, unknown>).environment = [{ variables: null }];
    lambda.change.after_unknown = { environment: [{ variables: true }] };
    plan.configuration = configurationSection(REAL_REFERENCES);
    const found = codes(plan, "initial");
    expect(found).toContain("simulator-flag-unresolved");
  });

  it("normalizes references to the thing they identify", () => {
    expect(normalizeReference("aws_lexv2models_bot.supplier_simulator.id")).toBe(
      "aws_lexv2models_bot.supplier_simulator",
    );
    expect(normalizeReference("aws_lexv2models_bot.supplier_simulator")).toBe(
      "aws_lexv2models_bot.supplier_simulator",
    );
    expect(normalizeReference("var.simulator_enabled")).toBe("var.simulator_enabled");
    expect(normalizeReference("local.lex_alias_name")).toBe("local.lex_alias_name");
    expect(normalizeReference("data.aws_iam_policy_document.lambda_assume.json")).toBe(
      "data.aws_iam_policy_document.lambda_assume",
    );
  });

  it("finds the references whichever container Terraform used", () => {
    // The documented nested-block encoding is an array; the object form and a
    // deeper wrapping are accepted too, so a shape difference cannot silently
    // become a policy failure.
    const shapes: unknown[] = [
      [{ variables: { references: REAL_REFERENCES } }],
      { variables: { references: REAL_REFERENCES } },
      [[{ variables: { references: REAL_REFERENCES } }]],
    ];
    for (const environment of shapes) {
      const plan = realCreatePlan({
        configuration: {
          root_module: {
            resources: [{ address: SIMULATOR_ARMING_ADDRESS, expressions: { environment } }],
          },
        },
      });
      expect(readEnvironmentReferences(plan, SIMULATOR_ARMING_ADDRESS).state).toBe("found");
      expect(evaluatePlan(plan, { mode: "initial" }).ok).toBe(true);
    }
  });

  it("applies the same normalization to the declared-input guards", () => {
    // Both guards compare the declared input directly. Before this fix they
    // compared against a JS boolean, so with the string form TF_VAR_ supplies
    // the initial-mode guard silently did nothing and - worse - the
    // qualification guard fired against a correctly armed run.
    const bare = (declared: unknown, enableRecording: unknown = "false") => ({
      format_version: "1.2",
      terraform_version: "1.14.5",
      variables: {
        simulator_enabled: { value: declared },
        enable_call_recording: { value: enableRecording },
      },
      resource_changes: [],
    });

    for (const armed of [true, "true"]) {
      expect(codes(bare(armed), "initial")).toContain("simulator-armed");
      expect(codes(bare(armed), "qualification")).not.toContain("simulator-not-armed");
    }
    for (const disarmed of [false, "false"]) {
      expect(codes(bare(disarmed), "initial")).not.toContain("simulator-armed");
      expect(codes(bare(disarmed), "qualification")).toContain("simulator-not-armed");
    }
    // Recording refusal must recognise both forms too.
    for (const recording of [true, "true"]) {
      expect(codes(bare(false, recording), "initial")).toContain("recording-enabled");
    }
    for (const recording of [false, "false"]) {
      expect(codes(bare(false, recording), "initial")).not.toContain("recording-enabled");
    }
  });

  it("normalizes exactly four canonical boolean forms and nothing else", () => {
    expect(canonicalBoolean(true)).toBe("true");
    expect(canonicalBoolean(false)).toBe("false");
    expect(canonicalBoolean("true")).toBe("true");
    expect(canonicalBoolean("false")).toBe("false");
    for (const rejected of ["TRUE", "True", "FALSE", "yes", "no", "1", "0", "", " true", 1, 0, null, undefined, {}, []]) {
      expect(canonicalBoolean(rejected)).toBeNull();
    }
  });

  it("reports why the configuration could not be read", () => {
    expect(readEnvironmentReferences({}, SIMULATOR_ARMING_ADDRESS).state).toBe("no-configuration-section");
    expect(readEnvironmentReferences(realCreatePlan(), SIMULATOR_ARMING_ADDRESS)).toEqual({
      state: "found",
      references: REAL_REFERENCES,
    });
  });
});

describe("forgetting a stale state entry", () => {
  /**
   * `forget` removes a STATE ENTRY and leaves the real resource alone. It is
   * the only way out of a state record that no longer matches its resource,
   * which is where the Connect Lex association ended up after a half-finished
   * apply. Terraform emits `delete` when a removed block omits
   * `destroy = false`, and `forget` only when it is set, so the action itself
   * is the evidence that nothing is destroyed.
   */
  function planWithAction(address: string, actions: string[]) {
    const plan = initialCreatePlan();
    plan.resource_changes.push(change(address, actions, {}, {}));
    return plan;
  }

  it("permits forget for the one address it is scoped to", () => {
    const plan = planWithAction(FORGETTABLE_STATE_ADDRESS, ["forget"]);
    const result = evaluatePlan(plan, { mode: "initial" });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.forgottenAddresses).toEqual([FORGETTABLE_STATE_ADDRESS]);
    expect(formatReport(result)).toContain("state entries forgotten      1 (nothing destroyed)");
  });

  it("refuses forget for any other address", () => {
    for (const address of [
      "aws_lambda_function.supplier_simulator",
      "aws_connect_contact_flow.supplier_simulator",
      "aws_lexv2models_bot.supplier_simulator",
      "aws_iam_role.lex_bot",
    ]) {
      const found = codes(planWithAction(address, ["forget"]), "initial");
      expect(found).toContain("forget-action");
    }
  });

  it("still refuses delete and replace on that same address", () => {
    // The allowance is for forget alone. A removed block without
    // destroy = false produces delete, and that must stay refused.
    expect(codes(planWithAction(FORGETTABLE_STATE_ADDRESS, ["delete"]), "initial")).toContain(
      "delete-action",
    );
    expect(
      codes(planWithAction(FORGETTABLE_STATE_ADDRESS, ["delete", "create"]), "initial"),
    ).toContain("replace-action");
  });

  it("does not treat the forgotten address as an unexpected resource", () => {
    const result = evaluatePlan(planWithAction(FORGETTABLE_STATE_ADDRESS, ["forget"]), {
      mode: "initial",
    });
    expect(result.unexpected).toEqual([]);
  });

  it("reports zero forgotten entries on an ordinary plan", () => {
    const result = evaluatePlan(initialCreatePlan(), { mode: "initial" });
    expect(result.forgottenAddresses).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("resnapshotting the Lex bot version", () => {
  function planWith(entries: [string, string[]][]) {
    const plan = initialCreatePlan();
    for (const [address, actions] of entries) {
      const existing = plan.resource_changes.find((rc: { address: string }) => rc.address === address);
      if (existing) existing.change.actions = actions;
      else plan.resource_changes.push(change(address, actions, {}, {}));
    }
    return plan;
  }

  it("permits replacing the version together with the alias repoint", () => {
    const plan = planWith([
      [REPLACEABLE_SNAPSHOT_ADDRESS, ["create", "delete"]],
      [REPOINTABLE_ALIAS_ADDRESS, ["update"]],
    ]);
    const result = evaluatePlan(plan, { mode: "initial" });
    expect(result.violations).toEqual([]);
    expect(result.snapshotReplacements).toEqual([REPLACEABLE_SNAPSHOT_ADDRESS]);
    expect(result.aliasRepoints).toEqual([REPOINTABLE_ALIAS_ADDRESS]);
  });

  it("refuses the alias update on its own, with no replacement to justify it", () => {
    // Without the resnapshot there is nothing for the alias to follow, so this
    // would be an ordinary unexplained update.
    const found = codes(planWith([[REPOINTABLE_ALIAS_ADDRESS, ["update"]]]), "initial");
    expect(found).toContain("update-action");
  });

  it("refuses replacement of any other resource", () => {
    for (const address of [
      "aws_lexv2models_bot.supplier_simulator",
      "aws_lambda_function.supplier_simulator",
      "aws_connect_contact_flow.supplier_simulator",
      REPOINTABLE_ALIAS_ADDRESS,
    ]) {
      expect(codes(planWith([[address, ["delete", "create"]]]), "initial")).toContain("replace-action");
    }
  });

  it("still refuses a plain delete of the version", () => {
    expect(codes(planWith([[REPLACEABLE_SNAPSHOT_ADDRESS, ["delete"]]]), "initial")).toContain(
      "delete-action",
    );
  });

  it("reports both counts on an ordinary plan as zero", () => {
    const result = evaluatePlan(initialCreatePlan(), { mode: "initial" });
    expect(result.snapshotReplacements).toEqual([]);
    expect(result.aliasRepoints).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("permits the alias repoint however the plan orders its resource changes", () => {
    // The alias must follow the resnapshot regardless of whether Terraform
    // emits it before or after the version, so the verdict cannot hinge on
    // an ordering the gate does not control.
    const plan = planWith([
      [REPLACEABLE_SNAPSHOT_ADDRESS, ["create", "delete"]],
      [REPOINTABLE_ALIAS_ADDRESS, ["update"]],
    ]);
    plan.resource_changes.reverse();
    const result = evaluatePlan(plan, { mode: "initial" });
    expect(result.violations).toEqual([]);
    expect(result.aliasRepoints).toEqual([REPOINTABLE_ALIAS_ADDRESS]);
  });
});

describe("rebuilding the Lex locale", () => {
  function planWith(entries: [string, string[]][]) {
    const plan = initialCreatePlan();
    for (const [address, actions] of entries) {
      const existing = plan.resource_changes.find((rc: { address: string }) => rc.address === address);
      if (existing) existing.change.actions = actions;
      else plan.resource_changes.push(change(address, actions, {}, {}));
    }
    return plan;
  }

  it("permits replacing the build step, which is its whole lifecycle", () => {
    const result = evaluatePlan(planWith([[REPLACEABLE_BUILD_ADDRESS, ["create", "delete"]]]), {
      mode: "initial",
    });
    expect(result.violations).toEqual([]);
    expect(result.buildReplacements).toEqual([REPLACEABLE_BUILD_ADDRESS]);
  });

  it("permits a rebuild that carries a resnapshot and an alias repoint", () => {
    const result = evaluatePlan(
      planWith([
        [REPLACEABLE_BUILD_ADDRESS, ["create", "delete"]],
        [REPLACEABLE_SNAPSHOT_ADDRESS, ["create", "delete"]],
        [REPOINTABLE_ALIAS_ADDRESS, ["update"]],
      ]),
      { mode: "initial" },
    );
    expect(result.violations).toEqual([]);
    expect(result.buildReplacements).toEqual([REPLACEABLE_BUILD_ADDRESS]);
    expect(result.snapshotReplacements).toEqual([REPLACEABLE_SNAPSHOT_ADDRESS]);
    expect(result.aliasRepoints).toEqual([REPOINTABLE_ALIAS_ADDRESS]);
  });

  it("still refuses a plain delete of the build step", () => {
    expect(codes(planWith([[REPLACEABLE_BUILD_ADDRESS, ["delete"]]]), "initial")).toContain(
      "delete-action",
    );
  });

  it("refuses replacement of a different terraform_data resource", () => {
    expect(codes(planWith([["terraform_data.something_else", ["delete", "create"]]]), "initial")).toContain(
      "replace-action",
    );
  });

  it("reports zero rebuilds on an ordinary plan", () => {
    const result = evaluatePlan(initialCreatePlan(), { mode: "initial" });
    expect(result.buildReplacements).toEqual([]);
    expect(result.ok).toBe(true);
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
