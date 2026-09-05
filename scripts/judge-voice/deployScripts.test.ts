import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Safety invariants for the deployment scripts.
 *
 * These scripts are the only things in the repository that run `terraform
 * apply` and touch a billable resource, so the properties that make them safe
 * to hand an operator belong in a test rather than in a comment nobody
 * re-reads.
 */
const scriptDir = join(__dirname);

function script(name: string): string {
  return readFileSync(join(scriptDir, name), "utf8");
}

const createSecret = script("create-access-code-secret.sh");
const stageA = script("stage-a.sh");
const bridge = script("bridge.sh");
const stageB = script("stage-b.sh");
const rollback = script("rollback.sh");

const applying = [
  ["stage-a.sh", stageA],
  ["stage-b.sh", stageB],
  ["rollback.sh", rollback],
] as const;

describe("nothing applies without an explicit typed confirmation", () => {
  it.each(applying)("%s reads a confirmation before terraform apply", (_name, source) => {
    expect(source).toMatch(/read -r CONFIRM/);
    expect(source).toMatch(/\[ "\$CONFIRM" = "(APPLY|ROLLBACK)" \]/);

    // The apply must come after the guard, not before it.
    expect(source.indexOf("read -r CONFIRM")).toBeLessThan(source.indexOf("terraform apply"));
  });

  it.each(applying)("%s applies a saved plan, never a fresh one", (_name, source) => {
    // `terraform apply` with no plan file would re-plan and apply whatever it
    // found, which is not what the operator reviewed.
    expect(source).toMatch(/terraform apply -input=false \S+\.tfplan/);
    expect(source).not.toMatch(/terraform apply\s+-auto-approve/);
    expect(source).not.toMatch(/terraform apply\s*$/m);
  });

  it("every script stops on the first error", () => {
    for (const source of [createSecret, stageA, bridge, stageB, rollback]) {
      expect(source).toContain("set -euo pipefail");
    }
  });
});

describe("the stage gate is enforced by the scripts, not just by Terraform", () => {
  it("stage A refuses a plan that contains a Connect contact flow", () => {
    expect(stageA).toContain("REFUSING: the Stage A plan contains a Connect contact flow.");
    expect(stageA).toContain('grep -q \'"type":"aws_connect_contact_flow"\'');
  });

  it("stage A proves the gate held, by asserting the DISABLED refusal", () => {
    // The one assertion that shows authentication works AND no contact can
    // start. Neither the test suite nor terraform validate can see this.
    expect(stageA).toContain('grep -q \'"reason":"DISABLED"\'');
    expect(stageA).toContain("no contact can start yet");
  });

  it("stage B refuses to run before the Lex association is verified", () => {
    expect(stageB).toContain("REFUSING: the judge Lex alias is not associated");
    // Read back from AWS, not inferred from the bridge having been run.
    expect(stageB).toContain("aws connect list-bots");
    expect(stageB.indexOf("aws connect list-bots")).toBeLessThan(
      stageB.indexOf("terraform plan"),
    );
  });

  it("the bridge verifies by reading the association back", () => {
    // An idempotent re-run and a genuine failure can look alike, so the exit
    // code is not the evidence.
    expect(bridge).toContain("aws connect list-bots");
    expect(bridge).toContain("Do NOT run Stage B");
  });

  it("stage B refuses a plan that deletes anything", () => {
    expect(stageB).toContain("REFUSING: the Stage B plan deletes something.");
  });
});

describe("the access code never reaches history, a log or the process list", () => {
  it("is read from a terminal, never from an argument", () => {
    expect(createSecret).toContain("read -rs ACCESS_CODE");
    expect(createSecret).toContain("refusing to read an access code without a terminal");
    // An --access-code flag would put the secret in shell history.
    expect(createSecret).not.toMatch(/--access-code\)/);
  });

  it("is confirmed twice and length-bounded", () => {
    expect(createSecret).toContain("read -rs ACCESS_CODE_AGAIN");
    expect(createSecret).toContain("the two entries differ");
    expect(createSecret).toContain('${#ACCESS_CODE}" -ge 12');
  });

  it("sends the digest to AWS on stdin, not as a command-line argument", () => {
    expect(createSecret).toContain("--secret-string file:///dev/stdin");
    expect(createSecret).not.toMatch(/--secret-string ["']?\$DIGEST/);
  });

  it("is cleared from the environment once used", () => {
    expect(createSecret).toContain("unset ACCESS_CODE ACCESS_CODE_AGAIN");
    expect(createSecret).toContain("unset DIGEST");
    expect(stageA).toContain("unset ACCESS_CODE");
    expect(stageA).toContain("unset TOKEN");
  });

  it("is never echoed back or written to a file by these scripts", () => {
    for (const [, source] of [["create", createSecret], ["stage-a", stageA]] as const) {
      expect(source).not.toMatch(/echo\s+"?\$ACCESS_CODE/);
      expect(source).not.toMatch(/\$ACCESS_CODE"?\s*>/);
      expect(source).not.toMatch(/echo\s+"?\$TOKEN/);
    }
  });
});

describe("rollback cannot destroy the durable state", () => {
  it("refuses any plan that deletes the procurement table", () => {
    expect(rollback).toContain("REFUSING: this plan would destroy the procurement table.");
    expect(rollback).toContain("consumed single-use tokens and audit chains");
  });

  it("offers voice-off before the full teardown", () => {
    expect(rollback).toContain("--voice-off");
    expect(rollback).toContain("connect_judge_flow_enabled=false");
  });

  it("reminds the operator to turn the portal flag off as well", () => {
    // Terraform cannot reach a built Pages bundle; the flag is the only thing
    // that stops the portal offering a voice button that can no longer work.
    expect(rollback).toContain("WEBRTC_JUDGE_MODE");
  });
});

describe("no script starts a billable contact", () => {
  it("never calls StartWebRTCContact", () => {
    for (const source of [createSecret, stageA, bridge, stageB, rollback]) {
      expect(source).not.toContain("start-web-rtc-contact");
      expect(source).not.toContain("StartWebRTCContact\"");
    }
  });

  it("verifies Stage B without opening a session", () => {
    // Doing so would cost money and would consume a single-use grant on a run
    // no judge is using.
    expect(stageB).toContain("without starting a contact");
    expect(stageB).not.toMatch(/curl[^\n]*voice-sessions/);
  });
});
