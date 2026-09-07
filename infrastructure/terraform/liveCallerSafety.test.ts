import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Safety invariants for the PSTN live caller.
 *
 * The live caller is now RETIRED (ADR-0001). qualification-caller.tf carries
 * only a `removed` block: no module is declared, and the six resources left in
 * the runtime state are torn down on the next apply. These invariants keep it
 * retired, and keep the still-present handler code and portal UI from claiming
 * controls the endpoint never had.
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

describe("the PSTN live caller is retired", () => {
  it("declares no module: a removed block tears the caller down instead", () => {
    expect(callerRoot).not.toMatch(/module\s+"qualification_caller"\s*{/);
    expect(callerRoot).toMatch(
      /removed\s*{[\s\S]*?from\s*=\s*module\.qualification_caller/,
    );
    expect(callerRoot).toMatch(/destroy\s*=\s*true/);
  });

  it("still keeps live_caller_enabled defaulting to false", () => {
    // The variable is now inert with no module referencing it, but until the
    // follow-up cleanup removes it, a true default would be a loaded gun.
    const block = variables.slice(variables.indexOf('variable "live_caller_enabled"'));
    expect(block).toContain('variable "live_caller_enabled"');
    expect(block.slice(0, block.indexOf("EOT"))).toMatch(/default\s*=\s*false/);
  });

  it("declares no Lambda Function URL and no caller URL output in the root", () => {
    expect(callerRoot).not.toMatch(/resource\s+"aws_lambda_function_url"/);
    expect(callerRoot).not.toMatch(/^\s*output\s+"qualification_caller_url"/m);
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
