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

/**
 * The whole `variable` block, including its heredoc description.
 *
 * Slices to the next declaration rather than to the next "EOT": that marker
 * also matches the heredoc's own opening delimiter, which would silently cut
 * every description off at its first line.
 */
function variableBlock(name: string): string {
  const start = variables.indexOf(`variable "${name}"`);
  expect(start).toBeGreaterThan(-1);
  const next = variables.indexOf('\nvariable "', start + 1);
  return variables.slice(start, next === -1 ? undefined : next);
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

const judgeVoice = repoFile("infrastructure", "terraform", "judge-voice.tf");

describe("the voice session endpoint cannot exist unauthenticated", () => {
  it("cannot be created without a JWT issuer and audience", () => {
    // Structural, not advisory: every voice resource carries this count.
    expect(judgeVoice).toContain("length(trimspace(var.judge_auth_issuer)) > 0");
    expect(judgeVoice).toContain("length(trimspace(var.judge_auth_audience)) > 0");
    expect(variableBlock("judge_auth_issuer")).toMatch(/default\s*=\s*""/);
    expect(variableBlock("judge_auth_audience")).toMatch(/default\s*=\s*""/);
  });

  it("attaches the authorizer to the one and only route", () => {
    expect(judgeVoice).toContain('authorization_type = "JWT"');
    expect(judgeVoice).toContain("authorizer_id      = aws_apigatewayv2_authorizer.voice_session[0].id");
    // A catch-all route would be an unauthenticated path by omission.
    expect(judgeVoice).not.toContain("$default\"\n  target");
    expect(judgeVoice).not.toContain('route_key          = "$default"');
  });

  it("never publishes a Lambda Function URL for the voice path", () => {
    expect(judgeVoice).not.toContain("aws_lambda_function_url");
    expect(judgeVoice).not.toContain('authorization_type = "NONE"');
  });

  it("restricts the browser origin and throttles the stage", () => {
    expect(judgeVoice).toContain("allow_origins     = [var.judge_portal_origin]");
    expect(judgeVoice).toContain("throttling_burst_limit = 5");
    expect(judgeVoice).toContain("throttling_rate_limit  = 2");
  });
});

describe("the voice path grants only what it needs", () => {
  it("scopes StartWebRTCContact to one flow on one instance", () => {
    const statement = judgeVoice.slice(judgeVoice.indexOf("StartJudgeWebRtcContact"));

    expect(statement).toContain('Action   = ["connect:StartWebRTCContact"]');
    expect(statement).toContain("contact-flow/${aws_connect_contact_flow.judge_voice[0].contact_flow_id}");
    expect(statement).not.toContain('"connect:*"');
  });

  it("gives the fulfilment Lambda no Connect and no telephony access", () => {
    const policy = judgeVoice.slice(
      judgeVoice.indexOf('resource "aws_iam_role_policy" "judge_voice"'),
      judgeVoice.indexOf('resource "aws_lambda_function" "judge_voice"'),
    );

    expect(policy).toContain("dynamodb:GetItem");
    expect(policy).not.toContain("connect:");
    expect(policy).not.toContain("secretsmanager:");
  });

  it("bounds how many contacts one judge can start", () => {
    expect(variableBlock("voice_sessions_per_judge_per_hour")).toContain("cost control");
    expect(judgeVoice).toContain("VOICE_SESSIONS_PER_HOUR");
  });
});

describe("the whole voice stack is off by default", () => {
  it("requires the master switch and the procurement table", () => {
    expect(judgeVoice).toContain("var.webrtc_judge_mode_enabled &&");
    expect(judgeVoice).toContain("var.procurement_table_enabled &&");
  });

  it("is never enabled by any workflow or example configuration", () => {
    for (const source of [
      repoFile(".github", "workflows", "terraform-apply.yml"),
      repoFile(".github", "workflows", "terraform-plan.yml"),
      repoFile("infrastructure", "terraform", "example.tfvars"),
    ]) {
      expect(source).not.toContain("judge_auth_issuer");
      expect(source).not.toContain("webrtc_judge_mode_enabled");
    }
  });
});
