import { describe, expect, it } from "vitest";

// @ts-expect-error -- .mjs module without type declarations; shape is asserted below.
import { evaluate, isDestructive, matches } from "./planGuard.mjs";

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

function plan(...changes: unknown[]) {
  return {
    resource_changes: changes,
    // Present in every real plan, and the source of the original false
    // positive: it lists the whole resulting state, untouched resources
    // included.
    planned_values: {
      root_module: {
        resources: [
          { address: "aws_connect_contact_flow.supplier_simulator", type: "aws_connect_contact_flow" },
          { address: "aws_dynamodb_table.procurement[0]", type: "aws_dynamodb_table" },
        ],
      },
    },
  };
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
    expect(result.lines.join("\n")).toContain("race the manual Lex association");
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

  it("refuses a plan that does not create the flow", () => {
    const result = evaluate("stage-b", plan(change("aws_lambda_function", "voice_session", ["update"], 0)));

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("does not create the judge contact flow");
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

  it("rejects an unknown check rather than passing it", () => {
    expect(evaluate("something-else", plan()).ok).toBe(false);
  });

  it("treats a plan with no resource_changes as having no changes", () => {
    expect(evaluate("stage-a", {}).ok).toBe(true);
    expect(evaluate("stage-b", {}).ok).toBe(false);
  });
});
