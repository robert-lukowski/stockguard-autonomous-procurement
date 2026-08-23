#!/usr/bin/env node
// @ts-check
/**
 * Runtime policy wrapper around assertQualificationPlan.mjs.
 *
 * The base gate remains the source of truth for Architecture A. This wrapper
 * adds only two reviewed recovery-era exceptions:
 *
 * 1) the simulator Lambda may move between reserved concurrency 0 (disarmed)
 *    and -1 / unreserved (armed), because this AWS account cannot allocate a
 *    positive reservation while preserving the account's required unreserved
 *    pool; and
 * 2) recovery mode may replace exactly the tainted simulator Lambda once,
 *    while simulator=false and recording=false, with every other resource
 *    still constrained by the base initial policy.
 *
 * No other update, delete, replacement or unexpected resource is permitted.
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  SIMULATOR_ARMING_ADDRESS,
  canonicalBoolean,
  classifyActions,
  evaluatePlan,
  formatReport,
} from "./assertQualificationPlan.mjs";

export const POLICY_MODES = Object.freeze(["initial", "qualification", "recovery"]);

const RECOVERY_IMMUTABLE_ATTRIBUTES = Object.freeze([
  "function_name",
  "role",
  "runtime",
  "handler",
  "timeout",
  "memory_size",
  "vpc_config",
  "file_system_config",
  "package_type",
]);

const RECOVERY_PROVIDER_DEFAULT_ATTRIBUTES = Object.freeze([
  "architectures",
  "layers",
  "kms_key_arn",
  "image_uri",
]);

function numericConcurrency(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function lambdaChange(plan) {
  return Array.isArray(plan?.resource_changes)
    ? plan.resource_changes.find(
        (rc) => rc?.mode === "managed" && rc?.address === SIMULATOR_ARMING_ADDRESS,
      )
    : undefined;
}

function actualCounts(plan) {
  const counts = {};
  for (const rc of plan?.resource_changes ?? []) {
    const action = classifyActions(rc?.change?.actions);
    counts[action] = (counts[action] ?? 0) + 1;
  }
  return counts;
}

function withViolations(base, mode, violations, extras = {}) {
  const counts = extras.counts ?? base.counts ?? {};
  return {
    ...base,
    ...extras,
    mode,
    counts,
    destructive: (counts.delete ?? 0) + (counts.replace ?? 0) + (counts.forget ?? 0),
    violations,
    ok: violations.length === 0,
  };
}

function isReservedConcurrencyAttributeViolation(v) {
  return (
    v?.address === SIMULATOR_ARMING_ADDRESS &&
    v?.code === "lambda-attribute-change" &&
    String(v?.detail ?? "").includes("reserved_concurrent_executions")
  );
}

function transitionIs(change, before, after) {
  if (classifyActions(change?.actions) !== "update") return false;
  return (
    numericConcurrency(change?.before?.reserved_concurrent_executions) === before &&
    numericConcurrency(change?.after?.reserved_concurrent_executions) === after
  );
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function canonicalProviderDefault(key, value) {
  switch (key) {
    case "architectures":
      if (value === undefined || value === null) return ["x86_64"];
      if (Array.isArray(value) && value.length === 0) return ["x86_64"];
      return value;
    case "layers":
      if (value === undefined || value === null) return [];
      return value;
    case "kms_key_arn":
    case "image_uri":
      if (value === undefined || value === null || value === "") return null;
      return value;
    default:
      return value;
  }
}

function providerDefaultEqual(key, before, after) {
  return jsonEqual(canonicalProviderDefault(key, before), canonicalProviderDefault(key, after));
}

/**
 * @param {unknown} plan
 * @param {{ mode: string }} options
 */
export function evaluateQualificationPolicy(plan, { mode }) {
  if (!POLICY_MODES.includes(mode)) {
    return evaluatePlan(plan, { mode });
  }

  if (mode === "recovery") {
    const original = evaluatePlan(plan, { mode: "initial" });
    const extra = [];

    const declaredSimulator = canonicalBoolean(plan?.variables?.simulator_enabled?.value);
    const declaredRecording = canonicalBoolean(plan?.variables?.enable_call_recording?.value);
    if (declaredSimulator !== "false") {
      extra.push({
        code: "recovery-simulator",
        address: "var.simulator_enabled",
        detail: "recovery mode requires simulator_enabled=false",
      });
    }
    if (declaredRecording !== "false") {
      extra.push({
        code: "recovery-recording",
        address: "var.enable_call_recording",
        detail: "recovery mode requires enable_call_recording=false",
      });
    }

    const managed = Array.isArray(plan?.resource_changes)
      ? plan.resource_changes.filter((rc) => rc?.mode === "managed")
      : [];
    const replacements = managed.filter(
      (rc) => classifyActions(rc?.change?.actions) === "replace",
    );
    const deletesOrForgets = managed.filter((rc) => {
      const action = classifyActions(rc?.change?.actions);
      return action === "delete" || action === "forget";
    });

    const lambda = lambdaChange(plan);
    const exactReplacement =
      replacements.length === 1 &&
      replacements[0]?.address === SIMULATOR_ARMING_ADDRESS &&
      deletesOrForgets.length === 0;

    if (!exactReplacement) {
      extra.push({
        code: "recovery-shape",
        address: SIMULATOR_ARMING_ADDRESS,
        detail: "recovery permits exactly one replacement: aws_lambda_function.supplier_simulator, with no delete or forget action anywhere else",
      });
    }

    const beforeConcurrency = numericConcurrency(
      lambda?.change?.before?.reserved_concurrent_executions,
    );
    const afterConcurrency = numericConcurrency(
      lambda?.change?.after?.reserved_concurrent_executions,
    );
    if (beforeConcurrency !== -1 || afterConcurrency !== 0) {
      extra.push({
        code: "recovery-concurrency",
        address: SIMULATOR_ARMING_ADDRESS,
        detail: `recovery replacement must be reserved_concurrent_executions -1 -> 0; planned transition is ${String(lambda?.change?.before?.reserved_concurrent_executions)} -> ${String(lambda?.change?.after?.reserved_concurrent_executions)}`,
      });
    }

    const before = lambda?.change?.before ?? {};
    const after = lambda?.change?.after ?? {};
    for (const key of RECOVERY_IMMUTABLE_ATTRIBUTES) {
      if (!jsonEqual(before?.[key], after?.[key])) {
        extra.push({
          code: "recovery-attribute-change",
          address: SIMULATOR_ARMING_ADDRESS,
          detail: `recovery replacement must not change ${key}`,
        });
      }
    }
    for (const key of RECOVERY_PROVIDER_DEFAULT_ATTRIBUTES) {
      if (!providerDefaultEqual(key, before?.[key], after?.[key])) {
        extra.push({
          code: "recovery-attribute-change",
          address: SIMULATOR_ARMING_ADDRESS,
          detail: `recovery replacement must not change ${key} beyond provider-default normalization`,
        });
      }
    }
    if (!jsonEqual(before?.environment, after?.environment)) {
      extra.push({
        code: "recovery-environment-change",
        address: SIMULATOR_ARMING_ADDRESS,
        detail: "recovery replacement must not change the Lambda environment",
      });
    }

    if (!exactReplacement) {
      return withViolations(original, mode, [...original.violations, ...extra], {
        counts: actualCounts(plan),
        recoveryReplacementApproved: false,
      });
    }

    // Let the mature initial policy evaluate the replacement's AFTER state as
    // a create. The real action is still retained in the returned counts and
    // destructive summary below, so the report remains transparent.
    const transformed = JSON.parse(JSON.stringify(plan));
    const transformedLambda = lambdaChange(transformed);
    transformedLambda.change.actions = ["create"];
    transformedLambda.change.before = null;

    const base = evaluatePlan(transformed, { mode: "initial" });
    return withViolations(base, mode, [...base.violations, ...extra], {
      counts: actualCounts(plan),
      recoveryReplacementApproved: extra.length === 0,
    });
  }

  const base = evaluatePlan(plan, { mode });
  const lambda = lambdaChange(plan);
  const change = lambda?.change;
  let violations = [...base.violations];

  if (mode === "qualification" && transitionIs(change, 0, -1)) {
    // Arming deliberately removes the zero-concurrency reservation. The base
    // gate still verifies that SIMULATOR_ENABLED changes false -> true and that
    // every other Lambda attribute/environment value remains unchanged.
    violations = violations.filter(
      (v) =>
        !(
          v?.address === SIMULATOR_ARMING_ADDRESS &&
          (v?.code === "lambda-concurrency" || isReservedConcurrencyAttributeViolation(v))
        ),
    );
  }

  if (mode === "initial" && transitionIs(change, -1, 0)) {
    // Disarming restores zero concurrency together with SIMULATOR_ENABLED=false.
    violations = violations.filter((v) => !isReservedConcurrencyAttributeViolation(v));
  }

  return withViolations(base, mode, violations, {
    concurrencyTransition:
      mode === "qualification" && transitionIs(change, 0, -1)
        ? "0 -> -1"
        : mode === "initial" && transitionIs(change, -1, 0)
          ? "-1 -> 0"
          : null,
  });
}

function parseArgs(argv) {
  const args = {
    plan: process.env.PLAN_JSON ?? "",
    mode: process.env.PLAN_POLICY_MODE ?? "",
    report: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--plan" || key === "--mode" || key === "--report") {
      if (value === undefined) throw new Error(`${key} requires a value`);
      args[key.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`unrecognized argument: ${key}`);
    }
  }
  return args;
}

const USAGE = `usage: assertQualificationPolicy.mjs --plan <tfplan.json> --mode <initial|qualification|recovery> [--report <out.json>]`;

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (!args.plan || !args.mode) {
    console.error(`--plan and --mode are both required.\n\n${USAGE}`);
    return 2;
  }

  let plan;
  try {
    plan = JSON.parse(readFileSync(args.plan, "utf8"));
  } catch (error) {
    console.error(`Could not read a JSON plan from ${args.plan}: ${error.message}`);
    return 2;
  }

  const result = evaluateQualificationPolicy(plan, { mode: args.mode });
  console.log(formatReport(result));

  if (args.report) {
    writeFileSync(args.report, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
