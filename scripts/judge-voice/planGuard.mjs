#!/usr/bin/env node
/**
 * Inspects a `terraform show -json` plan and refuses the dangerous shapes.
 *
 * This exists because the first version of these guards grepped the plan JSON
 * for strings, and got it wrong in three ways that a review caught:
 *
 *   - `planned_values` lists EVERY resource in the final state, not just the
 *     ones being changed. Grepping it for `aws_connect_contact_flow` matched
 *     the unconditional supplier flow in connect.tf, so a perfectly valid
 *     Stage A plan was refused every time.
 *   - a replacement is `["delete","create"]`, not `["delete"]`, so a grep for
 *     the latter waved replacements through while printing "deletes nothing".
 *   - a `.*` between two patterns spans the whole single-line JSON document,
 *     so it matched things that were nowhere near each other.
 *
 * The fix is to read `resource_changes`, which is the array of things this
 * plan will actually do, and to compare `type` and `name` as fields rather
 * than as substrings of a serialized blob.
 *
 * A second review caught two more, both about asking the wrong source:
 *
 *   - "creates no contact flow" is a question about ACTIONS, and it covers
 *     every flow, not only the judge one. Narrowing it to `judge_voice` let a
 *     plan that creates the supplier flow through Stage A.
 *   - "the flow is in place" is a question about the RESULTING STATE, which is
 *     what `planned_values` is for. Asking `resource_changes` for it refused
 *     every Stage B re-run, because a flow that already exists has no `create`
 *     action and may not appear there at all.
 *
 * So both sources are used here, each for the only question it answers.
 *
 * Reads the plan on stdin. Exits 0 when the plan is acceptable, 1 when it is
 * not, and prints why either way.
 *
 * USAGE
 *   terraform show -json stage-a.tfplan | node planGuard.mjs stage-a
 */

/** Terraform actions that destroy something, alone or as part of a replace. */
const DESTRUCTIVE = new Set(["delete"]);

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

/**
 * Every change the plan will apply.
 *
 * Deliberately NOT `planned_values`: that is the resulting state and includes
 * untouched resources, which is exactly the mistake this module was written to
 * stop repeating.
 */
export function resourceChanges(plan) {
  return Array.isArray(plan?.resource_changes) ? plan.resource_changes : [];
}

/**
 * Every resource in the state the plan would produce.
 *
 * This IS `planned_values`, used for the one question it actually answers:
 * will the resource exist afterwards. Asking that of `resource_changes` gets
 * the wrong answer for anything the plan leaves alone, because an unchanged
 * resource may not appear there at all.
 *
 * Recurses into child modules: qualification-caller.tf declares one, and a
 * resource inside a module never appears in `root_module.resources`.
 */
export function plannedResources(plan) {
  const out = [];
  const walk = (module) => {
    if (!module || typeof module !== "object") return;
    if (Array.isArray(module.resources)) out.push(...module.resources);
    if (Array.isArray(module.child_modules)) module.child_modules.forEach(walk);
  };
  walk(plan?.planned_values?.root_module);
  return out;
}

function actionsOf(change) {
  return Array.isArray(change?.change?.actions) ? change.change.actions : [];
}

export function isDestructive(change) {
  return actionsOf(change).some((action) => DESTRUCTIVE.has(action));
}

export function isCreated(change) {
  return actionsOf(change).includes("create");
}

/** Matches a resource by type and name, so `count` indices do not matter. */
export function matches(change, type, name) {
  return change?.type === type && change?.name === name;
}

/**
 * Runs one named check.
 *
 * Returns `{ ok, lines }` rather than printing, so the checks are testable
 * without capturing stdout.
 */
export function evaluate(planName, plan) {
  const changes = resourceChanges(plan);
  const lines = [];
  let ok = true;

  const refuse = (message) => {
    lines.push(`REFUSING: ${message}`);
    ok = false;
  };
  const note = (message) => lines.push(`  ok  ${message}`);

  const destructive = changes.filter(isDestructive);
  const judgeFlow = changes.filter((change) =>
    matches(change, "aws_connect_contact_flow", "judge_voice"),
  );

  if (planName === "stage-a") {
    /*
     * EVERY contact flow, not just the judge one. The supplier flow in
     * connect.tf hands the caller to Lex with ConnectParticipantWithLexBot,
     * which Connect validates against an existing bot association when the
     * flow is created - the same ordering hazard the two stages exist to
     * avoid. It is normally untouched (its association was made manually long
     * ago), but after a state recovery or a manual deletion the plan would
     * create it, and that apply would fail the same way.
     *
     * A no-op or an in-place update is not a creation and passes: that is the
     * ordinary case, and refusing it is what made the first guard unusable.
     */
    const created = changes.filter(
      (change) => change?.type === "aws_connect_contact_flow" && isCreated(change),
    );
    if (created.length > 0) {
      refuse(
        `the Stage A plan creates ${created.length} Connect contact flow(s): ` +
          `${created.map((change) => change.address).join(", ")}. ` +
          "Creating a flow here races the manual Lex association and fails " +
          "half-way. For the judge flow, connect_judge_flow_enabled should be " +
          "false at this stage.",
      );
    } else {
      note("no Connect contact flow is created, as Stage A requires");
    }
  } else if (planName === "stage-b") {
    /*
     * Whether the flow WILL EXIST, not whether it is being created. After a
     * successful Stage B - or an apply that created the flow and then failed
     * on a later resource - the next plan shows the flow as a no-op or omits
     * it entirely. Demanding a `create` action would refuse exactly the re-run
     * an operator needs to recover with.
     */
    const plannedFlow = plannedResources(plan).filter((resource) =>
      matches(resource, "aws_connect_contact_flow", "judge_voice"),
    );
    if (plannedFlow.length > 0) {
      note(
        judgeFlow.some(isCreated)
          ? "the judge contact flow is created"
          : "the judge contact flow already exists and is left in place",
      );
    } else {
      refuse(
        "the Stage B plan leaves no judge contact flow in place. " +
          "connect_judge_flow_enabled may not have taken effect.",
      );
    }
  } else if (planName === "rollback") {
    const table = changes.filter((change) =>
      matches(change, "aws_dynamodb_table", "procurement"),
    );
    if (table.some(isDestructive)) {
      refuse(
        "this plan would destroy or replace the procurement table. " +
          "It holds consumed single-use tokens and audit chains.",
      );
    } else {
      note("the procurement table is not destroyed or replaced");
    }
    // A rollback removes things on purpose, so a destructive plan is expected.
    // Only the table is protected.
    return { ok, lines };
  } else {
    return { ok: false, lines: [`unknown check: ${planName}`] };
  }

  /*
   * Applies to stage-a and stage-b. A replacement counts: Terraform writes it
   * as ["delete","create"], and destroying a live Lambda or API to recreate it
   * is not something to wave through on the way to a demo.
   */
  if (destructive.length > 0) {
    refuse(
      `the plan destroys or replaces ${destructive.length} resource(s): ` +
        destructive.map((change) => `${change.address} [${actionsOf(change).join(",")}]`).join(", "),
    );
  } else {
    note("nothing is destroyed or replaced");
  }

  return { ok, lines };
}

async function main() {
  const planName = process.argv[2];
  if (!planName) {
    console.error("usage: terraform show -json PLAN | node planGuard.mjs <stage-a|stage-b|rollback>");
    process.exit(2);
  }

  let plan;
  try {
    plan = JSON.parse(await readStdin());
  } catch {
    // An unreadable plan is not an acceptable plan.
    console.error("REFUSING: the plan JSON could not be parsed.");
    process.exit(1);
  }

  const { ok, lines } = evaluate(planName, plan);
  for (const line of lines) {
    (ok ? console.log : console.error)(line);
  }
  process.exit(ok ? 0 : 1);
}

// Importable for tests; only runs the CLI when executed directly.
if (process.argv[1] && process.argv[1].endsWith("planGuard.mjs")) {
  await main();
}
