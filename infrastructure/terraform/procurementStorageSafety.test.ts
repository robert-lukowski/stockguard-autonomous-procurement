import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Safety invariants for durable procurement storage and WebRTC Judge Mode.
 *
 * A separate file again, for the same reason as liveCallerSafety.test.ts: two
 * open pull requests are editing safetyInvariants.test.ts, and unrelated
 * assertions should not collide in the same hunks.
 */
const repoRoot = join(__dirname, "..", "..");

function repoFile(...segments: string[]): string {
  return readFileSync(join(repoRoot, ...segments), "utf8");
}

const storage = repoFile("infrastructure", "terraform", "procurement-storage.tf");
const variables = repoFile("infrastructure", "terraform", "variables.tf");

function variableBlock(name: string): string {
  const start = variables.indexOf(`variable "${name}"`);
  expect(start).toBeGreaterThan(-1);
  return variables.slice(start, variables.indexOf("EOT", start));
}

describe("procurement storage is disabled by default", () => {
  it("defaults both new switches to false", () => {
    expect(variableBlock("procurement_table_enabled")).toMatch(/default\s*=\s*false/);
    expect(variableBlock("webrtc_judge_mode_enabled")).toMatch(/default\s*=\s*false/);
  });

  it("gates the table and its policy on the table switch", () => {
    expect(storage).toContain("count = var.procurement_table_enabled ? 1 : 0");
    expect(storage).toContain("count = var.procurement_table_enabled ? 1 : 0");
    expect(storage).toContain("one(aws_dynamodb_table.procurement[*].name)");
  });

  it("is never enabled by any workflow or example configuration", () => {
    for (const source of [
      repoFile(".github", "workflows", "terraform-apply.yml"),
      repoFile(".github", "workflows", "terraform-plan.yml"),
      repoFile("infrastructure", "terraform", "example.tfvars"),
    ]) {
      expect(source).not.toMatch(/procurement_table_enabled\s*[:=]\s*"?true"?/);
      expect(source).not.toMatch(/webrtc_judge_mode_enabled\s*[:=]\s*"?true"?/);
    }
  });
});

describe("the procurement table cannot be destroyed by accident", () => {
  it("carries both deletion guards", () => {
    expect(storage).toContain("deletion_protection_enabled = true");
    expect(storage).toContain("prevent_destroy = true");
  });

  it("encrypts at rest, recovers to a point in time, and expires rows", () => {
    expect(storage).toContain("server_side_encryption");
    expect(storage).toContain("point_in_time_recovery");
    expect(storage).toContain('attribute_name = "expiresAtEpoch"');
  });
});

describe("table access is least privilege", () => {
  it("grants only the four verbs the adapters use, on one table", () => {
    const statement = storage.slice(storage.indexOf("ReadWriteProcurementSessions"));

    for (const action of [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]) {
      expect(statement).toContain(action);
    }
    expect(statement).not.toContain("dynamodb:Scan");
    expect(statement).not.toContain("dynamodb:DeleteItem");
    expect(statement).not.toContain("dynamodb:*");
    expect(statement).toContain("resources = [aws_dynamodb_table.procurement[0].arn]");
  });
});

describe("no in-memory adapter is described as a durable control", () => {
  it("says plainly what the in-memory procurement store is not", () => {
    const store = repoFile("src", "server", "procurement", "sessionStore.ts");

    expect(store).toContain("NOT durable");
    expect(store).toContain("does not survive a cold start");
  });

  it("says plainly what the in-memory voice store is not", () => {
    const store = repoFile("src", "server", "webrtc", "voiceSessionStore.ts");

    expect(store).toContain("NOT a durable single-use control");
    expect(store).toContain("NOT a ceiling");
  });
});
