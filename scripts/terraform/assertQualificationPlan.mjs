#!/usr/bin/env node
// @ts-check
/**
 * Terraform plan safety gate for the StockGuard qualification deployment.
 *
 * WHAT THIS IS
 * ------------
 * A deterministic policy checker that reads an ALREADY PRODUCED plan document
 * (`terraform show -json tfplan`) and decides whether that plan is allowed to
 * be applied.
 *
 * WHAT THIS DELIBERATELY IS NOT
 * -----------------------------
 * It never runs Terraform, never talks to AWS, and never reads credentials.
 * It has no imports beyond `node:fs` / `node:path`, which is asserted by a
 * test, so it cannot acquire that ability by accident.
 *
 * It also never greps human-readable plan text. Every decision is taken from
 * the documented machine-readable plan model: `resource_changes[].change.actions`
 * (Terraform's own change representation), `resource_changes[].type`, and the
 * top-level `variables` block.
 *
 * WHY A MACHINE GATE EXISTS AT ALL
 * --------------------------------
 * A human reading a 400-line plan for the first time, under time pressure,
 * reliably spots `destroy` and reliably misses one extra `aws_connect_*`
 * resource buried in the middle. The properties that must hold here are
 * mechanical, so a machine should hold them.
 */

import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// ARCHITECTURE A — the exact managed resource set.
//
// Derived by enumerating every `resource` block in infrastructure/terraform/*.tf
// that is NOT gated on `count = var.enable_call_recording ? 1 : 0`.
// `assertQualificationPlan.test.ts` re-derives this list from the .tf files on
// every test run, so it cannot silently drift from the configuration.
//
// None of these use count or for_each, so their plan addresses carry no index.
// ---------------------------------------------------------------------------
export const ARCHITECTURE_A_RESOURCES = Object.freeze([
  // Wrong-account tripwire.
  "terraform_data.account_guard",
  // Lambda and its execution role.
  "aws_cloudwatch_log_group.supplier_simulator",
  "aws_iam_role.supplier_simulator",
  "aws_iam_role_policy.supplier_simulator_logs",
  "aws_lambda_function.supplier_simulator",
  "aws_lambda_permission.lex_invoke",
  // Lex V2 bot, its service role, locale, intents, version and runtime alias.
  "aws_iam_role.lex_bot",
  "aws_iam_role_policy.lex_bot",
  "aws_lexv2models_bot.supplier_simulator",
  "aws_lexv2models_bot_locale.en",
  "aws_lexv2models_intent.get_supplier_quote",
  "aws_lexv2models_intent.confirm_commercial_terms",
  "aws_lexv2models_intent.end_conversation",
  "aws_lexv2models_bot_version.v1",
  "awscc_lex_bot_alias.supplier_simulator",
  // The contact flow. The existing +1 number is NOT assigned to it by Terraform.
  "aws_connect_contact_flow.supplier_simulator",
]);

/**
 * The single resource whose only reason to change is arming the simulator.
 * `var.simulator_enabled` is referenced in exactly one place in the whole
 * configuration: SIMULATOR_ENABLED in this function's environment block.
 */
export const SIMULATOR_ARMING_ADDRESS = "aws_lambda_function.supplier_simulator";

export const EXPECTED_LAMBDA_RUNTIME = "nodejs22.x";
/** Reserved concurrency must stay bounded; unreserved (null) is a violation. */
export const MAX_RESERVED_CONCURRENCY = 10;

/**
 * Attributes of the simulator Lambda that arming must never touch. Checked by
 * value comparison between `before` and `after`, not by name matching, so a
 * provider that renames a field cannot slip a change past this.
 */
const LAMBDA_IMMUTABLE_ATTRIBUTES = Object.freeze([
  "function_name",
  "role",
  "runtime",
  "handler",
  "timeout",
  "memory_size",
  "reserved_concurrent_executions",
  "architectures",
  "layers",
  "vpc_config",
  "kms_key_arn",
  "file_system_config",
  "image_uri",
  "package_type",
]);

// ---------------------------------------------------------------------------
// Forbidden resource categories.
//
// Every one of these would also be caught by the allowlist as "unexpected",
// but naming them produces a violation message that says WHAT was wrong rather
// than merely that something was. `match` runs against the resource type.
// ---------------------------------------------------------------------------
const FORBIDDEN_CATEGORIES = Object.freeze([
  {
    id: "connect-instance",
    reason: "creates or changes an Amazon Connect instance; the existing sandbox instance is reused, never managed",
    match: (t) => /^(aws|awscc)_connect_instance$/.test(t),
  },
  {
    id: "phone-number",
    reason: "claims, releases or associates a telephone number; the existing +1 number is only ever reassigned by hand",
    match: (t) => t.includes("phone_number"),
  },
  {
    id: "connect-storage-config",
    reason: "attaches a Connect storage configuration, which would replace whatever the instance already has",
    match: (t) => /connect_instance_storage_config/.test(t),
  },
  {
    id: "recording-storage",
    reason: "creates S3 storage; Architecture A has no S3 resource, so this can only be call recording",
    match: (t) => /^(aws|awscc)_s3_/.test(t) || /^aws_s3control_/.test(t),
  },
  {
    id: "dynamodb",
    reason: "creates DynamoDB state; the qualification runtime is stateless by design",
    match: (t) => t.includes("dynamodb"),
  },
  {
    id: "secrets-manager",
    reason: "creates a secret store; the Lambda holds no secrets and makes no AWS API calls",
    match: (t) => t.includes("secretsmanager") || t.includes("ssm_parameter"),
  },
  {
    id: "kms-customer-key",
    reason: "creates a customer-managed KMS key, which carries a key policy and a deletion window nobody has reviewed",
    match: (t) => /^(aws|awscc)_kms_(key|replica_key|external_key)$/.test(t),
  },
  {
    id: "step-functions",
    reason: "creates Step Functions orchestration, which is not part of Architecture A",
    match: (t) => /^aws_sfn_/.test(t) || t.includes("stepfunctions"),
  },
  {
    id: "deployed-caller",
    reason: "creates an internet-reachable or outbound-calling surface, which is how a deployed CALL-E caller would appear",
    match: (t) =>
      t.includes("apigateway") ||
      t.includes("lambda_function_url") ||
      t.includes("voice_connector") ||
      t.includes("chime") ||
      t.includes("pinpoint") ||
      /^(aws|awscc)_sns_/.test(t) ||
      /^aws_cloudwatch_event_/.test(t) ||
      /^aws_scheduler_/.test(t),
  },
]);

const IAM_TYPE = /^(aws|awscc)_iam_/;

// ---------------------------------------------------------------------------
// Plan model helpers.
// ---------------------------------------------------------------------------

/**
 * Collapse Terraform's action list into one label.
 * Terraform represents a replacement as ["delete","create"], or
 * ["create","delete"] under create_before_destroy. Anything not recognised
 * fails closed rather than being treated as harmless.
 * @param {string[] | undefined} actions
 */
export function classifyActions(actions) {
  const key = (actions ?? []).join(",");
  switch (key) {
    case "no-op":
      return "no-op";
    case "create":
      return "create";
    case "read":
      return "read";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "forget":
      return "forget";
    case "delete,create":
    case "create,delete":
      return "replace";
    default:
      return `unrecognized:${key || "empty"}`;
  }
}

/** Terraform encodes a resource block attribute as a single-element list. */
function unwrapBlock(value) {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : undefined;
  return value;
}

/**
 * Resolve the planned SIMULATOR_ENABLED value for the simulator Lambda.
 *
 * `after` carries known values with unknowns nulled out, and `after_unknown`
 * marks which of them are unknown. SIMULATOR_ENABLED is derived from a plain
 * input variable, so it must be known at plan time; "unknown" is reported
 * distinctly from "absent" because the two mean different things and both
 * fail closed.
 * @returns {{ state: "known" | "unknown" | "absent", value: string | null }}
 */
export function readSimulatorFlag(change) {
  return readSimulatorFlagFrom(change?.after, change?.after_unknown);
}

/**
 * Same extraction against an arbitrary side of the change. `before` is prior
 * state and so is never unknown, but it is read through the same code path so
 * the two sides cannot drift apart.
 * @returns {{ state: "known" | "unknown" | "absent", value: string | null }}
 */
export function readSimulatorFlagFrom(side, unknownSide) {
  const vars = unwrapBlock(side?.environment)?.variables;
  const unknownVars = unwrapBlock(unknownSide?.environment)?.variables;

  if (unknownVars === true || unknownVars?.SIMULATOR_ENABLED === true) {
    return { state: "unknown", value: null };
  }
  if (!vars || typeof vars !== "object") return { state: "absent", value: null };
  const raw = vars.SIMULATOR_ENABLED;
  if (raw === undefined || raw === null) return { state: "absent", value: null };
  return { state: "known", value: String(raw) };
}

/**
 * Normalise a configuration reference to the thing it identifies.
 *
 *   "aws_lexv2models_bot.supplier_simulator.id" -> "aws_lexv2models_bot.supplier_simulator"
 *   "aws_lexv2models_bot.supplier_simulator"    -> unchanged (Terraform emits both)
 *   "var.simulator_enabled"                     -> unchanged
 *   "local.lex_alias_name"                      -> unchanged
 */
export function normalizeReference(reference) {
  const parts = String(reference).split(".");
  if (parts[0] === "var" || parts[0] === "local" || parts[0] === "module") {
    return parts.slice(0, 2).join(".");
  }
  if (parts[0] === "data") return parts.slice(0, 3).join(".");
  return parts.slice(0, 2).join(".");
}

/**
 * Find a `variables` node holding a references array inside an environment
 * expression, whatever container Terraform wrapped it in.
 * @returns {string[] | null}
 */
function findVariablesReferences(node, depth) {
  if (depth <= 0 || node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findVariablesReferences(item, depth - 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  const variables = node.variables;
  if (variables && typeof variables === "object" && Array.isArray(variables.references)) {
    return variables.references;
  }
  for (const value of Object.values(node)) {
    const hit = findVariablesReferences(value, depth - 1);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * The references Terraform records for the simulator Lambda's environment
 * variables expression, read out of the plan's own `configuration` section.
 *
 * IMPORTANT, and verified against Terraform 1.14.5 rather than assumed:
 * Terraform collapses an object-constructor expression into ONE references
 * array for the whole map. There is no per-key reference data, so it is not
 * possible to prove from a plan that SIMULATOR_ENABLED specifically, as
 * opposed to the map as a whole, references var.simulator_enabled. What can
 * be proved is that the map still references var.simulator_enabled and that
 * every other thing it references is part of the reviewed configuration.
 *
 * @returns {{ state: string, references: string[] }}
 */
export function readEnvironmentReferences(plan, address) {
  const resources = plan?.configuration?.root_module?.resources;
  if (!Array.isArray(resources)) return { state: "no-configuration-section", references: [] };
  const entry = resources.find((r) => r?.address === address);
  if (!entry) return { state: "resource-absent-from-configuration", references: [] };
  const environment = entry?.expressions?.environment;
  if (environment === undefined || environment === null) {
    return { state: "no-environment-variables-expression", references: [] };
  }

  // Terraform documents a nested block as an ARRAY of block representations,
  // so the expected shape is environment[0].variables.references. That was not
  // directly observable here without running a plan against AWS, so rather
  // than betting on one encoding this searches the environment expression for
  // a `variables` node carrying a references array, at any depth, and fails
  // closed with a named state if there is none. Depth is bounded so a
  // malformed document cannot spin.
  const found = findVariablesReferences(environment, 6);
  if (found === null) return { state: "no-references-recorded", references: [] };
  return { state: "found", references: found.map(String) };
}

/**
 * Normalise a declared boolean input to "true" / "false", accepting ONLY the
 * four canonical forms and refusing everything else.
 *
 * Both forms occur in practice and were verified against Terraform 1.14.5
 * rather than assumed:
 *
 *   boolean  - a value supplied through a .tfvars file or -var
 *   string   - a value supplied through TF_VAR_*, which is how both workflows
 *              pass it. Environment variables are strings, and the plan JSON
 *              records the variable as given, so a `bool` variable arrives
 *              here as the STRING "false".
 *
 * Deliberately NOT accepted, even though Terraform itself would coerce some of
 * them: "TRUE", "True", "yes", "1", 0, 1, null, undefined, or a missing key.
 * A value this policy cannot recognise exactly is a value it refuses.
 *
 * @returns {"true" | "false" | null}
 */
export function canonicalBoolean(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  if (value === "true") return "true";
  if (value === "false") return "false";
  return null;
}

/**
 * Last-resort resolution of SIMULATOR_ENABLED when the planned value itself is
 * opaque.
 *
 * On a CREATE the aws provider reports the whole environment variables map as
 * unknown, because ALLOWED_LEX_BOT_IDS references a bot that does not exist
 * yet. The flag is genuinely knowable, just not readable from `after`.
 *
 * This does NOT assume "false". It requires two further facts, both read out
 * of the same plan document:
 *
 *   a) the declared input, plan.variables.simulator_enabled.value, is a
 *      boolean and already matches what this policy mode demands, and
 *   b) the plan's configuration still wires the map to var.simulator_enabled,
 *      and references nothing beyond that variable, other input variables,
 *      locals, and resources inside the Architecture A set.
 *
 * Anything missing, ambiguous or rewired keeps failing closed.
 *
 * @returns {{ ok: true, value: string, references: string[] } | { ok: false, reason: string }}
 */
export function resolveSimulatorFlagFromConfiguration(plan, mode, expectedValue) {
  const raw = plan?.variables?.simulator_enabled?.value;
  const declared = canonicalBoolean(raw);
  if (declared === null) {
    return {
      ok: false,
      reason: `plan.variables.simulator_enabled.value is ${JSON.stringify(raw)}, which is not one of the four accepted forms (true, false, "true", "false"), so the declared input cannot corroborate it`,
    };
  }
  if (declared !== expectedValue) {
    return {
      ok: false,
      reason: `the declared input simulator_enabled=${declared} does not match the "${expectedValue}" the ${mode} policy requires`,
    };
  }

  const { state, references } = readEnvironmentReferences(plan, SIMULATOR_ARMING_ADDRESS);
  if (state !== "found") {
    return { ok: false, reason: `the plan's configuration does not expose the environment variables expression (${state})` };
  }

  const normalized = [...new Set(references.map(normalizeReference))];
  if (!normalized.includes("var.simulator_enabled")) {
    return {
      ok: false,
      reason: `the environment variables expression no longer references var.simulator_enabled (it references: ${normalized.join(", ") || "nothing"})`,
    };
  }

  const foreign = normalized.filter(
    (reference) =>
      !reference.startsWith("var.") &&
      !reference.startsWith("local.") &&
      !ARCHITECTURE_A_RESOURCES.includes(reference),
  );
  if (foreign.length > 0) {
    return {
      ok: false,
      reason: `the environment variables expression references something outside the reviewed configuration: ${foreign.join(", ")}`,
    };
  }

  return { ok: true, value: expectedValue, references: normalized };
}

function envVariables(side) {
  const vars = unwrapBlock(side?.environment)?.variables;
  return vars && typeof vars === "object" ? vars : {};
}

/** Keys whose value differs between before and after, JSON-compared. */
function changedKeys(before, after, keys) {
  const out = [];
  for (const key of keys) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The policy.
// ---------------------------------------------------------------------------

export const POLICY_MODES = Object.freeze(["initial", "qualification"]);

/**
 * @param {unknown} plan  parsed `terraform show -json` document
 * @param {{ mode: string }} options
 */
export function evaluatePlan(plan, { mode }) {
  /** @type {{ code: string, address: string, detail: string }[]} */
  const violations = [];
  const add = (code, address, detail) => violations.push({ code, address, detail });

  if (!POLICY_MODES.includes(mode)) {
    add("bad-mode", "-", `unknown policy mode "${mode}"; expected one of ${POLICY_MODES.join(", ")}`);
    return finish(plan, mode, violations, null, { counts: {}, unexpected: [], present: [] });
  }
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.resource_changes)) {
    add(
      "unreadable-plan",
      "-",
      "document has no resource_changes array; this is not a `terraform show -json` plan",
    );
    return finish(plan, mode, violations, null, { counts: {}, unexpected: [], present: [] });
  }

  const expected = new Set(ARCHITECTURE_A_RESOURCES);
  const allowedManagedActions =
    mode === "initial" ? new Set(["create", "no-op"]) : new Set(["no-op"]);

  /**
   * The one SIMULATOR_ENABLED transition each mode exists to perform.
   *
   * Qualification arms the runtime. Initial covers BOTH the first deployment
   * and the rollback that disarms afterwards - a rollback selects
   * simulator_enabled=false, which is the initial policy, and disarming is a
   * legitimate `update` to a resource that exists. Without this the rollback
   * in the runbook could not be executed through the gated path at all, which
   * would have pushed the operator to disarm by hand.
   *
   * It stays exactly one update to exactly one resource, changing exactly one
   * environment variable, under the same immutable-attribute protections as
   * arming. No other update permission is widened.
   */
  const flagTransition =
    mode === "qualification"
      ? { from: "false", to: "true", verb: "arming" }
      : { from: "true", to: "false", verb: "disarming" };

  /** @type {Record<string, number>} */
  const counts = {};
  const unexpected = [];
  const present = [];
  let simulatorFlag = null;
  let lambdaCodeChanged = false;
  let flagUpdates = 0;
  let flagChange = null;
  let flagSource = "planned value";

  // --- 1. Input variables. Known before any resource is inspected. ----------
  // Normalised through the same four-form reader as the corroboration path.
  // TF_VAR_* supplies these as strings, so comparing the raw value against a
  // JavaScript boolean would silently disable the initial-mode guard and,
  // worse, make the qualification guard fire against a correctly armed run.
  const declaredSimulator = canonicalBoolean(plan.variables?.simulator_enabled?.value);
  const declaredRecording = canonicalBoolean(plan.variables?.enable_call_recording?.value);

  if (declaredRecording === "true") {
    add(
      "recording-enabled",
      "var.enable_call_recording",
      "recording is enabled; no policy mode permits it until the instance is confirmed to have no existing CALL_RECORDINGS configuration",
    );
  }
  if (mode === "initial" && declaredSimulator === "true") {
    add(
      "simulator-armed",
      "var.simulator_enabled",
      "initial deployment must not arm the simulator; use the qualification policy for that, as a separate deliberate act",
    );
  }
  if (mode === "qualification" && declaredSimulator !== "true") {
    add(
      "simulator-not-armed",
      "var.simulator_enabled",
      "qualification policy exists only to arm the simulator, but simulator_enabled is not true",
    );
  }

  // --- 2. Every planned change. --------------------------------------------
  for (const rc of plan.resource_changes) {
    const address = String(rc.address ?? "<no address>");
    const type = String(rc.type ?? "");
    const action = classifyActions(rc.change?.actions);
    counts[action] = (counts[action] ?? 0) + 1;

    // Data sources may only be read or be no-ops, in every mode. A data source
    // performs no mutation, so `read` is always safe.
    if (rc.mode === "data") {
      if (action !== "read" && action !== "no-op") {
        add("data-source-action", address, `data source planned as ${action}`);
      }
      continue;
    }
    if (rc.mode !== "managed") {
      add("unknown-mode", address, `resource mode "${rc.mode}" is neither managed nor data`);
      continue;
    }

    // 2a. Destructive actions, checked before anything else so that a delete
    //     of an ALLOWED resource is still a violation.
    if (action === "delete" || action === "replace" || action === "forget") {
      add(
        `${action}-action`,
        address,
        action === "replace"
          ? `planned for replacement (actions: ${(rc.change?.actions ?? []).join(",")}), which destroys the existing resource`
          : `planned for ${action}`,
      );
    } else if (!allowedManagedActions.has(action)) {
      // 2b. update in initial mode, or any unrecognised action anywhere.
      // The simulator flag update is the ONLY update either policy permits,
      // and the transition it must carry is checked below.
      const isFlagUpdate = action === "update" && address === SIMULATOR_ARMING_ADDRESS;
      if (isFlagUpdate) {
        flagUpdates += 1;
      } else if (action === "update") {
        add(
          "update-action",
          address,
          `the ${mode} policy permits exactly one update, ${flagTransition.verb} ${SIMULATOR_ARMING_ADDRESS}; every other managed resource must be create, read or no-op`,
        );
      } else if (action === "create") {
        add(
          "create-in-qualification",
          address,
          "qualification policy arms an existing runtime and cannot create resources; run the initial deployment first",
        );
      } else {
        add("unrecognized-action", address, `plan action ${action} is not recognised, so it is refused`);
      }
    }

    // 2c. Forbidden categories, by resource type.
    const category = FORBIDDEN_CATEGORIES.find((c) => c.match(type));
    if (category) {
      add(`forbidden:${category.id}`, address, `${type} ${category.reason}`);
    }

    // 2d. The allowlist.
    if (expected.has(address)) {
      present.push(address);
    } else if (!category) {
      unexpected.push(address);
      add(
        IAM_TYPE.test(type) ? "unexpected-iam" : "unexpected-resource",
        address,
        IAM_TYPE.test(type)
          ? `IAM resource outside the StockGuard qualification runtime (${type})`
          : `${type} is not part of the Architecture A resource set`,
      );
    } else {
      unexpected.push(address);
    }

    // 2e. Simulator Lambda specifics.
    if (address === SIMULATOR_ARMING_ADDRESS && action !== "no-op") {
      const after = rc.change?.after ?? {};
      const before = rc.change?.before ?? {};

      const planned = readSimulatorFlag(rc.change);
      const wanted = flagTransition.to;

      // On a create the aws provider reports the whole environment variables
      // map as unknown, because ALLOWED_LEX_BOT_IDS references a bot that does
      // not exist yet. Corroborate from the declared input and the plan's own
      // configuration rather than assuming a value - and only on a create.
      // On an update the values are concrete, so the arming and disarming
      // transition checks must keep reading the real planned value.
      let flag = planned;
      let fallbackReason = null;
      if (planned.state !== "known" && action === "create") {
        const corroborated = resolveSimulatorFlagFromConfiguration(plan, mode, wanted);
        if (corroborated.ok) {
          flag = { state: "known", value: corroborated.value };
          flagSource = "declared input + configuration";
        } else {
          fallbackReason = corroborated.reason;
          flagSource = "planned value (unknown); corroboration refused";
        }
      }
      simulatorFlag = flag;

      if (flag.state !== "known") {
        add(
          "simulator-flag-unresolved",
          address,
          action === "create"
            ? `SIMULATOR_ENABLED is ${planned.state} in the planned value, so it was checked against the declared input and the plan's configuration instead. That corroboration was REFUSED: ${fallbackReason}. Failing closed rather than assuming "${wanted}".`
            : `SIMULATOR_ENABLED is ${planned.state} in the planned value, and this is an ${action}, where corroboration is deliberately not offered because the values are concrete. Failing closed rather than assuming "${wanted}".`,
        );
      } else if (flag.value !== wanted) {
        add(
          "simulator-flag-mismatch",
          address,
          `SIMULATOR_ENABLED is planned as "${flag.value}" but the ${mode} policy requires "${wanted}"`,
        );
      }

      if (after.runtime !== undefined && after.runtime !== EXPECTED_LAMBDA_RUNTIME) {
        add("lambda-runtime", address, `runtime is planned as ${after.runtime}, expected ${EXPECTED_LAMBDA_RUNTIME}`);
      }
      const reserved = after.reserved_concurrent_executions;
      if (reserved === undefined || reserved === null || reserved < 0 || reserved > MAX_RESERVED_CONCURRENCY) {
        add(
          "lambda-concurrency",
          address,
          `reserved_concurrent_executions is ${reserved === null || reserved === undefined ? "unset, so the function is unreserved" : reserved}; it must stay bounded at or below ${MAX_RESERVED_CONCURRENCY}`,
        );
      }

      if (action === "update") {
        // The update must be the flag transition this mode exists to perform,
        // and nothing else. `before` is prior state, so a value that is not
        // known there means the transition cannot be confirmed - fail closed
        // rather than infer it from `after` alone.
        const beforeFlag = readSimulatorFlagFrom(before);
        flagChange = `${beforeFlag.value ?? beforeFlag.state} -> ${flag.value ?? flag.state}`;
        if (beforeFlag.state !== "known") {
          add(
            "simulator-flag-unresolved",
            address,
            `SIMULATOR_ENABLED is ${beforeFlag.state} in the plan's prior state, so this cannot be confirmed to be the ${flagTransition.verb} update the ${mode} policy permits`,
          );
        } else if (beforeFlag.value !== flagTransition.from) {
          add(
            "simulator-flag-transition",
            address,
            `the only update the ${mode} policy permits here is ${flagTransition.verb}: SIMULATOR_ENABLED "${flagTransition.from}" -> "${flagTransition.to}". This plan starts from "${beforeFlag.value}".`,
          );
        }

        // The transition may change the environment and, if the bundle rebuild
        // is not byte-identical, the code hash. It may change nothing else.
        const frozen = changedKeys(before, after, LAMBDA_IMMUTABLE_ATTRIBUTES);
        for (const key of frozen) {
          add("lambda-attribute-change", address, `${flagTransition.verb} must not change ${key}`);
        }
        const beforeEnv = envVariables(before);
        const afterEnv = envVariables(after);
        const envKeys = new Set([...Object.keys(beforeEnv), ...Object.keys(afterEnv)]);
        for (const key of envKeys) {
          if (key === "SIMULATOR_ENABLED") continue;
          if (JSON.stringify(beforeEnv[key]) !== JSON.stringify(afterEnv[key])) {
            add("lambda-env-change", address, `${flagTransition.verb} must not change environment variable ${key}`);
          }
        }
        lambdaCodeChanged = before.source_code_hash !== after.source_code_hash;
      }
    }
  }

  // Initial mode has no equivalent requirement: it is also the first-deployment
  // policy, where there is nothing to disarm.
  if (mode === "qualification" && flagUpdates === 0 && violations.length === 0) {
    add(
      "nothing-to-arm",
      SIMULATOR_ARMING_ADDRESS,
      "qualification policy expected exactly one update arming the simulator, but the plan contains none",
    );
  }

  return finish(plan, mode, violations, simulatorFlag, {
    counts,
    unexpected,
    present,
    lambdaCodeChanged,
    declaredSimulator,
    declaredRecording,
    flagChange,
    flagSource,
  });
}

function finish(plan, mode, violations, simulatorFlag, extra) {
  const counts = extra.counts ?? {};
  const present = extra.present ?? [];
  return {
    ok: violations.length === 0,
    mode,
    terraformVersion: typeof plan?.terraform_version === "string" ? plan.terraform_version : "unknown",
    formatVersion: typeof plan?.format_version === "string" ? plan.format_version : "unknown",
    counts,
    destructive: (counts.delete ?? 0) + (counts.replace ?? 0) + (counts.forget ?? 0),
    expectedTotal: ARCHITECTURE_A_RESOURCES.length,
    expectedPresent: present.length,
    // Absence is not a safety failure: a missing resource can only mean fewer
    // changes, and any resource removed from a live configuration would show
    // up as a delete and be caught above. Reported so it is still visible.
    expectedMissing: ARCHITECTURE_A_RESOURCES.filter((a) => !present.includes(a)),
    unexpected: extra.unexpected ?? [],
    simulatorEnabled: simulatorFlag?.state === "known" ? simulatorFlag.value : (simulatorFlag?.state ?? "not-planned"),
    declaredSimulatorEnabled: extra.declaredSimulator ?? null,
    declaredCallRecording: extra.declaredRecording ?? null,
    lambdaCodeChanged: Boolean(extra.lambdaCodeChanged),
    simulatorFlagChange: extra.flagChange ?? null,
    simulatorFlagSource: extra.flagSource ?? "planned value",
    recordingResourcesPresent: violations.some(
      (v) => v.code === "forbidden:recording-storage" || v.code === "forbidden:connect-storage-config",
    ),
    violations,
  };
}

// ---------------------------------------------------------------------------
// Reporting. Addresses, types, counts and the SIMULATOR_ENABLED literal only.
// No account id, no phone number, no secret, no contact-flow body: nothing
// from `change.after` is ever printed.
// ---------------------------------------------------------------------------

export function formatReport(result) {
  const yesNo = (b) => (b ? "yes" : "no");
  const actions = Object.entries(result.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ") || "none";

  const lines = [
    `Terraform plan policy: ${result.ok ? "PASS" : "FAIL"}`,
    `  policy mode                  ${result.mode}`,
    `  terraform / plan format      ${result.terraformVersion} / ${result.formatVersion}`,
    `  resource actions             ${actions}`,
    `  expected managed resources   ${result.expectedPresent} of ${result.expectedTotal}`,
    `  unexpected resources         ${result.unexpected.length}`,
    `  delete / replace             ${result.destructive}`,
    `  simulator armed              ${result.simulatorEnabled === "true" ? "yes" : result.simulatorEnabled === "false" ? "no" : `undetermined (${result.simulatorEnabled})`}`,
    `  recording resources present  ${yesNo(result.recordingResourcesPresent)}`,
    `  simulator flag read from     ${result.simulatorFlagSource}`,
  ];
  if (result.simulatorFlagChange) {
    lines.push(`  SIMULATOR_ENABLED change     ${result.simulatorFlagChange}`);
  }
  if (result.lambdaCodeChanged) lines.push("  lambda bundle hash changed   yes");
  if (result.expectedMissing.length > 0) {
    lines.push(`  note: not in this plan       ${result.expectedMissing.join(", ")}`);
  }
  if (!result.ok) {
    lines.push("", `Refusing this plan. ${result.violations.length} violation(s):`);
    for (const v of result.violations) lines.push(`  [${v.code}] ${v.address}`, `      ${v.detail}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { plan: process.env.PLAN_JSON ?? "", mode: process.env.PLAN_POLICY_MODE ?? "", report: "" };
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

const USAGE = `usage: assertQualificationPlan.mjs --plan <tfplan.json> --mode <initial|qualification> [--report <out.json>]

Produce the input with:  terraform show -json tfplan > tfplan.json
This tool never invokes Terraform or AWS itself.`;

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

  const result = evaluatePlan(plan, { mode: args.mode });
  console.log(formatReport(result));

  if (args.report) {
    // Sanitized by construction: this object holds no plan values.
    writeFileSync(args.report, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result.ok ? 0 : 1;
}

// Only run when executed directly, so the module stays importable by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}