import { describe, expect, it } from "vitest";

import {
  ARCHITECTURE_A_RESOURCES,
  SIMULATOR_ARMING_ADDRESS,
  // @ts-expect-error - plain .mjs module
} from "./assertQualificationPlan.mjs";
import {
  evaluateQualificationPolicy,
  // @ts-expect-error - plain .mjs module
} from "./assertQualificationPolicy.mjs";

const LAMBDA_ENV = {
  SIMULATOR_ENABLED: "false",
  ALLOWED_LEX_BOT_IDS: "ABCDEFGHIJ",
  ALLOWED_LEX_ALIAS_NAMES: "qualification",
  ALLOWED_LEX_LOCALES: "en_US",
  QUALIFICATION_SKU: "CF-220",
  QUALIFICATION_QUANTITY: "8",
  QUALIFICATION_REQUIRED_BY: "2026-08-28T12:00:00+02:00",
};

function lambdaAttributes(flag: "true" | "false", concurrency: number) {
  return {
    function_name: "stockguard-qualification-supplier-simulator",
    handler: "index.lexFulfillment",
    runtime: "nodejs22.x",
    timeout: 10,
    memory_size: 256,
    reserved_concurrent_executions: concurrency,
    role: "arn:aws:iam::000000000000:role/stockguard-qualification-supplier-simulator",
    source_code_hash: "hash-a",
    environment: [{ variables: { ...LAMBDA_ENV, SIMULATOR_ENABLED: flag } }],
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

function basePlan(simulatorEnabled: boolean) {
  return {
    format_version: "1.2",
    terraform_version: "1.14.5",
    variables: {
      simulator_enabled: { value: simulatorEnabled },
      enable_call_recording: { value: false },
    },
    resource_changes: ARCHITECTURE_A_RESOURCES.map((address: string) =>
      change(address, ["no-op"], {}, {}),
    ),
  };
}

function target(plan: ReturnType<typeof basePlan>, address: string) {
  return plan.resource_changes.find((rc) => rc.address === address)!;
}

describe("reviewed Lambda recovery policy", () => {
  it("accepts exactly one disarmed simulator Lambda replacement", () => {
    const plan = basePlan(false);
    const lambda = target(plan, SIMULATOR_ARMING_ADDRESS);
    lambda.change.actions = ["delete", "create"];
    lambda.change.before = lambdaAttributes("false", -1);
    lambda.change.after = lambdaAttributes("false", 0);

    for (const address of [
      "aws_iam_role_policy.lex_bot",
      "awscc_lex_bot_alias.supplier_simulator",
      "aws_lambda_permission.lex_invoke",
      "aws_connect_contact_flow.supplier_simulator",
    ]) {
      target(plan, address).change.actions = ["create"];
      target(plan, address).change.before = null;
    }

    const result = evaluateQualificationPolicy(plan, { mode: "recovery" });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.counts.replace).toBe(1);
    expect(result.counts.create).toBe(4);
    expect(result.destructive).toBe(1);
    expect(result.recoveryReplacementApproved).toBe(true);
    expect(result.simulatorEnabled).toBe("false");
  });

  it("refuses recovery when any second resource is replaced", () => {
    const plan = basePlan(false);
    const lambda = target(plan, SIMULATOR_ARMING_ADDRESS);
    lambda.change.actions = ["delete", "create"];
    lambda.change.before = lambdaAttributes("false", -1);
    lambda.change.after = lambdaAttributes("false", 0);
    target(plan, "aws_connect_contact_flow.supplier_simulator").change.actions = [
      "delete",
      "create",
    ];

    const result = evaluateQualificationPolicy(plan, { mode: "recovery" });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v: { code: string }) => v.code)).toContain(
      "recovery-shape",
    );
  });

  it("refuses recovery unless the replacement leaves Lambda concurrency at zero", () => {
    const plan = basePlan(false);
    const lambda = target(plan, SIMULATOR_ARMING_ADDRESS);
    lambda.change.actions = ["delete", "create"];
    lambda.change.before = lambdaAttributes("false", -1);
    lambda.change.after = lambdaAttributes("false", -1);

    const result = evaluateQualificationPolicy(plan, { mode: "recovery" });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v: { code: string }) => v.code)).toContain(
      "recovery-concurrency",
    );
  });

  it("refuses recovery if the simulator is requested armed", () => {
    const plan = basePlan(true);
    const lambda = target(plan, SIMULATOR_ARMING_ADDRESS);
    lambda.change.actions = ["delete", "create"];
    lambda.change.before = lambdaAttributes("false", -1);
    lambda.change.after = lambdaAttributes("true", 0);

    const result = evaluateQualificationPolicy(plan, { mode: "recovery" });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v: { code: string }) => v.code)).toContain(
      "recovery-simulator",
    );
  });
});

describe("zero-concurrency arming and rollback", () => {
  it("accepts arming only as concurrency 0 -> -1 plus SIMULATOR_ENABLED false -> true", () => {
    const plan = basePlan(true);
    const lambda = target(plan, SIMULATOR_ARMING_ADDRESS);
    lambda.change.actions = ["update"];
    lambda.change.before = lambdaAttributes("false", 0);
    lambda.change.after = lambdaAttributes("true", -1);

    const result = evaluateQualificationPolicy(plan, { mode: "qualification" });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.concurrencyTransition).toBe("0 -> -1");
  });

  it("accepts disarming only as concurrency -1 -> 0 plus SIMULATOR_ENABLED true -> false", () => {
    const plan = basePlan(false);
    const lambda = target(plan, SIMULATOR_ARMING_ADDRESS);
    lambda.change.actions = ["update"];
    lambda.change.before = lambdaAttributes("true", -1);
    lambda.change.after = lambdaAttributes("false", 0);

    const result = evaluateQualificationPolicy(plan, { mode: "initial" });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.concurrencyTransition).toBe("-1 -> 0");
  });

  it("does not waive the concurrency violations for any other transition", () => {
    const plan = basePlan(true);
    const lambda = target(plan, SIMULATOR_ARMING_ADDRESS);
    lambda.change.actions = ["update"];
    lambda.change.before = lambdaAttributes("false", 2);
    lambda.change.after = lambdaAttributes("true", -1);

    const result = evaluateQualificationPolicy(plan, { mode: "qualification" });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v: { code: string }) => v.code)).toContain(
      "lambda-concurrency",
    );
  });
});
