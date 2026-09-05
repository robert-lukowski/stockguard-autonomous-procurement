import { describe, expect, it } from "vitest";

// @ts-expect-error -- .mjs module without type declarations; shape is asserted below.
import { evaluate, isDestructive, matches, plannedResources } from "./planGuard.mjs";

/**
 * The plan shapes that matter, written the way Terraform actually writes them.
 *
 * Every case here is one a review found the string-grepping version getting
 * wrong. Testing the guard against fixtures is the only way to check it without
 * an AWS account, and it is what stops the same mistakes coming back.
 */

type Actions = string[];

function change(type: string, name: string, actions: Actions, index?: number) {
  const address = index === undefined ? `${type}.${name}` : `${type}.${name}[${index}]`;
  return { address, type, name, change: { actions } };
}

type Change = ReturnType<typeof change>;

const SUPPLIER_FLOW = {
  address: "aws_connect_contact_flow.supplier_simulator",
  type: "aws_connect_contact_flow",
  name: "supplier_simulator",
};

/**
 * A plan with both of the views Terraform writes, kept consistent with each
 * other.
 *
 * `planned_values` is derived from the changes rather than hand-written, so a
 * fixture cannot claim a resulting state the changes contradict. It always
 * carries the supplier flow, which connect.tf declares unconditionally and
 * which is what the first guard tripped over. Anything being destroyed
 * outright is absent from it, as Terraform writes it.
 */
function plan(...changes: Change[]) {
  const surviving = changes
    .filter((entry) => !(entry.change.actions.includes("delete") && !entry.change.actions.includes("create")))
    .map((entry) => ({ address: entry.address, type: entry.type, name: entry.name }));

  return {
    resource_changes: changes,
    planned_values: { root_module: { resources: [SUPPLIER_FLOW, ...surviving] } },
  };
}

/** A plan whose resulting state is stated outright, for the absent-change cases. */
function planWithState(changes: Change[], resources: unknown[]) {
  return { resource_changes: changes, planned_values: { root_module: { resources } } };
}

describe("Stage A", () => {
  it("accepts a plan that leaves the pre-existing supplier flow alone", () => {
    /*
     * THE regression. connect.tf declares aws_connect_contact_flow
     * .supplier_simulator unconditionally, so it appears in planned_values of
     * every plan. The first guard grepped for the type and refused every valid
     * Stage A plan, which made the script unusable.
     */
    const result = evaluate(
      "stage-a",
      plan(
        change("aws_dynamodb_table", "procurement", ["create"], 0),
        change("aws_lambda_function", "judge_login", ["create"], 0),
      ),
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a plan that creates the judge contact flow", () => {
    const result = evaluate(
      "stage-a",
      plan(change("aws_connect_contact_flow", "judge_voice", ["create"], 0)),
    );

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("races the manual Lex association");
  });

  it("refuses a plan that creates the SUPPLIER contact flow too", () => {
    /*
     * Narrowing the check to judge_voice was the over-correction for the
     * original false positive. The supplier flow hands the caller to Lex with
     * ConnectParticipantWithLexBot, and connect.tf records that its
     * association was made by hand - so creating it here fails at apply for
     * exactly the reason the two stages exist. It only ever plans a create
     * after a state recovery or a manual deletion, which is when an operator
     * most needs to be stopped.
     */
    const result = evaluate(
      "stage-a",
      plan(change("aws_connect_contact_flow", "supplier_simulator", ["create"])),
    );

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("supplier_simulator");
  });

  it("accepts an in-place update to a flow that already exists", () => {
    const result = evaluate(
      "stage-a",
      plan(change("aws_connect_contact_flow", "supplier_simulator", ["update"])),
    );

    expect(result.ok).toBe(true);
  });

  it("accepts a no-op on the judge flow", () => {
    // A second Stage A run sees the flow unchanged; that is not a creation.
    const result = evaluate(
      "stage-a",
      plan(change("aws_connect_contact_flow", "judge_voice", ["no-op"], 0)),
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a plan that destroys something", () => {
    const result = evaluate(
      "stage-a",
      plan(change("aws_lambda_function", "judge_voice", ["delete"], 0)),
    );

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("destroys or replaces 1 resource");
  });
});

describe("Stage B", () => {
  it("accepts creating the judge flow plus in-place updates", () => {
    const result = evaluate(
      "stage-b",
      plan(
        change("aws_connect_contact_flow", "judge_voice", ["create"], 0),
        change("aws_lambda_function", "voice_session", ["update"], 0),
        change("aws_iam_role_policy", "voice_session", ["update"], 0),
      ),
    );

    expect(result.ok).toBe(true);
  });

  it("accepts a re-run where the flow already exists and is untouched", () => {
    /*
     * The recovery case. After a successful Stage B - or an apply that created
     * the flow and then failed on a later resource - the flow is a no-op and
     * has no `create` action. Demanding one refused precisely the re-run an
     * operator needs, and there is no other supported way to finish a partial
     * apply.
     */
    const result = evaluate(
      "stage-b",
      plan(
        change("aws_connect_contact_flow", "judge_voice", ["no-op"], 0),
        change("aws_lambda_function", "voice_session", ["update"], 0),
      ),
    );

    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("already exists and is left in place");
  });

  it("accepts a re-run where the flow is absent from resource_changes entirely", () => {
    // Terraform may omit an unchanged resource from resource_changes, so its
    // absence there says nothing about whether it exists.
    const result = evaluate(
      "stage-b",
      planWithState(
        [change("aws_lambda_function", "voice_session", ["update"], 0)],
        [
          SUPPLIER_FLOW,
          {
            address: "aws_connect_contact_flow.judge_voice[0]",
            type: "aws_connect_contact_flow",
            name: "judge_voice",
          },
        ],
      ),
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a plan that leaves no judge flow in place at all", () => {
    const result = evaluate(
      "stage-b",
      planWithState([change("aws_lambda_function", "voice_session", ["update"], 0)], [SUPPLIER_FLOW]),
    );

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("leaves no judge contact flow in place");
  });

  it("refuses a REPLACEMENT, in either order Terraform writes it", () => {
    /*
     * A replacement is ["delete","create"] (or ["create","delete"] for
     * create_before_destroy), never a bare ["delete"]. The first guard matched
     * only the bare form, so a plan that destroyed a live Lambda to recreate it
     * reached the apply while the script printed "deletes nothing".
     */
    for (const actions of [
      ["delete", "create"],
      ["create", "delete"],
    ]) {
      const result = evaluate(
        "stage-b",
        plan(
          change("aws_connect_contact_flow", "judge_voice", ["create"], 0),
          change("aws_apigatewayv2_api", "voice_session", actions, 0),
        ),
      );

      expect(result.ok).toBe(false);
      expect(result.lines.join("\n")).toContain("destroys or replaces");
    }
  });
});

describe("rollback", () => {
  it("accepts destroying the voice stack", () => {
    // A rollback removes things on purpose; only the table is protected.
    const result = evaluate(
      "rollback",
      plan(
        change("aws_connect_contact_flow", "judge_voice", ["delete"], 0),
        change("aws_lambda_function", "judge_voice", ["delete"], 0),
      ),
    );

    expect(result.ok).toBe(true);
  });

  it("refuses destroying the procurement table", () => {
    const result = evaluate(
      "rollback",
      plan(change("aws_dynamodb_table", "procurement", ["delete"], 0)),
    );

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("consumed single-use tokens and audit chains");
  });

  it("refuses REPLACING the procurement table", () => {
    const result = evaluate(
      "rollback",
      plan(change("aws_dynamodb_table", "procurement", ["delete", "create"], 0)),
    );

    expect(result.ok).toBe(false);
  });

  it("is not confused by a table and an unrelated delete far apart in the JSON", () => {
    /*
     * The first guard used '"type":"aws_dynamodb_table".*"actions":\["delete"\]'
     * against single-line JSON, so the .* spanned the whole document and matched
     * a table and an unrelated deletion that had nothing to do with each other.
     */
    const result = evaluate(
      "rollback",
      plan(
        change("aws_dynamodb_table", "procurement", ["no-op"], 0),
        change("aws_lambda_function", "judge_login", ["delete"], 0),
      ),
    );

    expect(result.ok).toBe(true);
  });
});

describe("guard primitives", () => {
  it("treats every action array containing delete as destructive", () => {
    expect(isDestructive(change("x", "y", ["delete"]))).toBe(true);
    expect(isDestructive(change("x", "y", ["delete", "create"]))).toBe(true);
    expect(isDestructive(change("x", "y", ["create", "delete"]))).toBe(true);
    expect(isDestructive(change("x", "y", ["create"]))).toBe(false);
    expect(isDestructive(change("x", "y", ["update"]))).toBe(false);
    expect(isDestructive(change("x", "y", ["no-op"]))).toBe(false);
  });

  it("matches on type and name, so a count index does not matter", () => {
    expect(matches(change("aws_dynamodb_table", "procurement", [], 0), "aws_dynamodb_table", "procurement")).toBe(true);
    expect(matches(change("aws_dynamodb_table", "other", [], 0), "aws_dynamodb_table", "procurement")).toBe(false);
  });

  it("finds resources inside child modules", () => {
    // qualification-caller.tf declares a module, and a resource inside one
    // never appears in root_module.resources.
    const nested = {
      planned_values: {
        root_module: {
          resources: [SUPPLIER_FLOW],
          child_modules: [
            {
              resources: [{ address: "module.q.aws_lambda_function.caller", type: "aws_lambda_function", name: "caller" }],
            },
          ],
        },
      },
    };

    expect(plannedResources(nested)).toHaveLength(2);
    expect(plannedResources({})).toEqual([]);
  });

  it("rejects an unknown check rather than passing it", () => {
    expect(evaluate("something-else", plan()).ok).toBe(false);
  });

  it("treats a plan with no resource_changes as having no changes", () => {
    expect(evaluate("stage-a", {}).ok).toBe(true);
    expect(evaluate("stage-b", {}).ok).toBe(false);
  });
});
