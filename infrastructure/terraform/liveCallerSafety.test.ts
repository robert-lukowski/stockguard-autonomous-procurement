import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Safety invariants for the PSTN live caller.
 *
 * Deliberately a separate file from `safetyInvariants.test.ts`: that file is
 * being edited by an open pull request, and splitting these assertions out
 * keeps two unrelated changes from colliding in the same hunks.
 *
 * The property under test: the one resource in this repository that can spend
 * money by placing a real telephone call cannot be created by accident.
 */
const repoRoot = join(__dirname, "..", "..");

function repoFile(...segments: string[]): string {
  return readFileSync(join(repoRoot, ...segments), "utf8");
}

function tf(name: string): string {
  return repoFile("infrastructure", "terraform", name);
}

const variables = tf("variables.tf");
const callerRoot = tf("qualification-caller.tf");
const callerModule = repoFile(
  "infrastructure",
  "terraform",
  "modules",
  "qualification-caller",
  "main.tf",
);

describe("live caller is disabled by default", () => {
  it("declares live_caller_enabled and defaults it to false", () => {
    const block = variables.slice(variables.indexOf('variable "live_caller_enabled"'));
    expect(block).toContain('variable "live_caller_enabled"');
    expect(block.slice(0, block.indexOf("EOT"))).toMatch(/default\s*=\s*false/);
  });

  it("creates the caller module only when that variable is true", () => {
    expect(callerRoot).toContain("count  = var.live_caller_enabled ? 1 : 0");
  });

  it("keeps the public Function URL inside the gated module", () => {
    // If this ever moves to the root module it stops being gated by count.
    expect(callerRoot).not.toContain("aws_lambda_function_url");
    expect(callerModule).toContain('resource "aws_lambda_function_url" "this"');
    expect(callerModule).toContain('authorization_type = "NONE"');
  });

  it("returns a null URL output when the caller is disabled", () => {
    expect(callerRoot).toContain("one(module.qualification_caller[*].url)");
  });

  it("is never enabled by any workflow or example configuration", () => {
    for (const source of [
      repoFile(".github", "workflows", "terraform-apply.yml"),
      repoFile(".github", "workflows", "terraform-plan.yml"),
      repoFile("infrastructure", "terraform", "example.tfvars"),
    ]) {
      expect(source).not.toMatch(/live_caller_enabled\s*[:=]\s*"?true"?/);
    }
  });
});

describe("no control is described as something it is not", () => {
  it("states in Terraform that there is no rate limit or concurrency cap", () => {
    expect(callerModule).toContain("PUBLIC, UNAUTHENTICATED ENDPOINT THAT SPENDS MONEY");
    expect(callerModule).toContain("a rate limit. There is none.");
    expect(callerModule).toContain("a durable call budget.");
    expect(variables).toContain("there is NO server-side rate limit");
  });

  it("marks the per-workflow call map as per-container, not a spend control", () => {
    const adapter = repoFile("src", "server", "calle", "CallEApiAdapter.ts");
    const comment = adapter.slice(0, adapter.indexOf("startedCallsByWorkflow = new Map"));

    expect(comment).toContain("NOT a spend control");
    expect(comment).toContain("does not survive a Lambda cold start");
  });

  it("does not let the portal claim a rate limit the backend never enforces", () => {
    const handler = repoFile(
      "infrastructure",
      "terraform",
      "lambda",
      "liveCallerHandler.ts",
    );
    const panel = repoFile("src", "ui", "LiveQualificationPanel.tsx");

    // The premise of the assertion below: the handler returns no 429.
    expect(handler).not.toContain("429");
    expect(panel).not.toContain("status === 429");
    expect(panel).toContain("implements no");
  });
});
