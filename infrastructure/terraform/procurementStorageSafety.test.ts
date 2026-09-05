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
  it("guards its only route with the judge Lambda authorizer", () => {
    expect(judgeVoice).toMatch(/route_key\s+= "POST \/voice-sessions"/);
    // CUSTOM is how an HTTP API attaches a Lambda authorizer; JWT would be
    // rejected at apply time and terraform validate does not catch it.
    expect(judgeVoice).toContain('authorization_type = "CUSTOM"');
    expect(judgeVoice).not.toContain('authorization_type = "JWT"');
    expect(judgeVoice).toContain(
      "authorizer_id      = aws_apigatewayv2_authorizer.voice_session[0].id",
    );
    expect(judgeVoice).toContain('authorizer_type                   = "REQUEST"');
    expect(judgeVoice).toContain(
      "authorizer_uri                    = aws_lambda_function.judge_authorizer[0].invoke_arn",
    );
  });

  it("never caches an authorization decision", () => {
    // A cache would keep a revoked or expired token working for its lifetime,
    // which is the whole thing a short-lived token is meant to prevent.
    expect(judgeVoice).toContain("authorizer_result_ttl_in_seconds  = 0");
  });

  it("leaves sign-in as the only unauthenticated route, and only that one", () => {
    const unauthenticated = judgeVoice.match(/authorization_type = "NONE"/g) ?? [];
    expect(unauthenticated).toHaveLength(1);
    expect(judgeVoice).toMatch(/route_key\s+= "POST \/judge-sessions"/);
    // A catch-all would be an unauthenticated path by omission.
    expect(judgeVoice).not.toMatch(/route_key\s+= "\$default"/);
  });

  it("never publishes a Lambda Function URL for the voice path", () => {
    expect(judgeVoice).not.toContain("aws_lambda_function_url");
  });

  it("restricts the browser origin and throttles the stage", () => {
    expect(judgeVoice).toContain("allow_origins     = [var.judge_portal_origin]");
    expect(judgeVoice).toContain("throttling_burst_limit = 5");
    expect(judgeVoice).toContain("throttling_rate_limit  = 2");
  });
});

describe("judge sign-in uses the existing PBKDF2 access-code path", () => {
  it("reads the digest from a manually created Secrets Manager secret", () => {
    expect(judgeVoice).toContain('data "aws_secretsmanager_secret" "judge_access_code"');
    expect(variableBlock("judge_access_code_secret_name")).toContain("Created MANUALLY");
    expect(variableBlock("judge_access_code_secret_name")).toContain("PBKDF2-SHA256");
  });

  it("commits no access code, digest or session token", () => {
    // The variable description names the schema fields on purpose; what must
    // never appear is a VALUE assigned to one of them.
    for (const source of [judgeVoice, variables, repoFile(".github", "workflows", "deploy-pages.yml")]) {
      expect(source).not.toMatch(/(derivedKeyBase64|saltBase64)\s*[:=]\s*["'][A-Za-z0-9+/]{8}/);
      expect(source).not.toMatch(/JUDGE_ACCESS_CODE\s*[:=]\s*["'][^"'$]/);
      expect(source).not.toMatch(/accessCode\s*[:=]\s*["'][^"'$]/);
    }
  });

  it("gives the auth Lambdas read-only access to that one secret and no Connect", () => {
    const policy = judgeVoice.slice(
      judgeVoice.indexOf('resource "aws_iam_role_policy" "judge_auth"'),
      judgeVoice.indexOf('data "archive_file" "judge_login"'),
    );

    expect(policy).toContain('Action   = ["secretsmanager:GetSecretValue"]');
    expect(policy).toContain(
      "Resource = data.aws_secretsmanager_secret.judge_access_code[0].arn",
    );
    expect(policy).not.toContain("secretsmanager:PutSecretValue");
    expect(policy).not.toContain("connect:");
    expect(policy).not.toContain("dynamodb:Scan");
  });

  it("bounds sign-in attempts and session lifetime", () => {
    expect(variableBlock("judge_login_attempts_per_window")).toContain("ground down");
    expect(variableBlock("judge_session_ttl_minutes")).toContain("worthless soon after");
    expect(judgeVoice).toContain("LOGIN_ATTEMPTS_PER_WINDOW");
    expect(judgeVoice).toContain("JUDGE_SESSION_TTL_MS");
  });
});

describe("Pages configuration carries no secret", () => {
  it("passes only flags and URLs to the build", () => {
    const pages = repoFile(".github", "workflows", "deploy-pages.yml");
    const viteVars = pages.match(/VITE_[A-Z_]+/g) ?? [];

    expect(viteVars).toContain("VITE_WEBRTC_JUDGE_MODE");
    expect(viteVars).toContain("VITE_WEBRTC_SESSION_URL");
    expect(viteVars).toContain("VITE_JUDGE_LOGIN_URL");
    for (const name of viteVars) {
      expect(name).not.toMatch(/CODE|TOKEN|SECRET|PIN|KEY|PASSWORD/);
    }
    // Repository VARIABLES, never secrets: these values are public by design.
    expect(pages).not.toMatch(/VITE_[A-Z_]+:\s*\$\{\{\s*secrets\./);
  });
});

describe("the two deployment stages", () => {
  it("keeps the Connect flow out of Stage A", () => {
    expect(judgeVoice).toContain("judge_flow_enabled = local.judge_voice_enabled && var.connect_judge_flow_enabled");
    expect(variableBlock("connect_judge_flow_enabled")).toMatch(/default\s*=\s*false/);
    expect(variableBlock("connect_judge_flow_enabled")).toContain("STAGE B ONLY");

    const flow = judgeVoice.slice(judgeVoice.indexOf('resource "aws_connect_contact_flow" "judge_voice"'));
    expect(flow.slice(0, 300)).toContain("count = local.judge_flow_count");
  });

  it("withholds StartWebRTCContact entirely until Stage B", () => {
    expect(judgeVoice).toContain("local.judge_flow_enabled ? [{");
    expect(judgeVoice).toContain('Action   = ["connect:StartWebRTCContact"]');
  });

  it("leaves the session Lambda with no flow id in Stage A, so it refuses", () => {
    expect(judgeVoice).toContain(
      'judge_voice_flow_id = local.judge_flow_enabled ? aws_connect_contact_flow.judge_voice[0].contact_flow_id : ""',
    );
    expect(judgeVoice).toContain("CONNECT_WEBRTC_FLOW_ID  = local.judge_voice_flow_id");
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

  it("no longer requires an external identity provider", () => {
    expect(variables).not.toContain("judge_auth_issuer");
    expect(variables).not.toContain("judge_auth_audience");
    expect(judgeVoice).not.toContain("jwt_configuration");
  });

  it("bounds how many contacts one judge can start", () => {
    expect(variableBlock("voice_sessions_per_judge_per_hour")).toContain("cost control");
    expect(judgeVoice).toContain("VOICE_SESSIONS_PER_HOUR");
  });
});

describe("the whole voice stack is off by default", () => {
  it("requires the master switch and the procurement table", () => {
    expect(judgeVoice).toContain(
      "judge_voice_enabled = var.webrtc_judge_mode_enabled && var.procurement_table_enabled",
    );
    expect(variableBlock("webrtc_judge_mode_enabled")).toMatch(/default\s*=\s*false/);
    expect(variableBlock("procurement_table_enabled")).toMatch(/default\s*=\s*false/);
  });

  it("is never enabled by any workflow or example configuration", () => {
    for (const source of [
      repoFile(".github", "workflows", "terraform-apply.yml"),
      repoFile(".github", "workflows", "terraform-plan.yml"),
      repoFile("infrastructure", "terraform", "example.tfvars"),
    ]) {
      expect(source).not.toContain("webrtc_judge_mode_enabled");
      expect(source).not.toContain("connect_judge_flow_enabled");
    }
  });
});
