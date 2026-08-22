import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The post-apply verification script is allowed to look at AWS and nothing
 * else. These tests hold that property mechanically rather than trusting the
 * comment at the top of the file: they parse the AWS CLI invocations out of
 * the script and check every verb against a read-only allowlist.
 */
const script = readFileSync(join(__dirname, "verifyAwsRuntime.sh"), "utf8");

/** Lines that actually execute, with comments removed. */
const executable = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

/** Every `aws <service> <verb>` pair the script can execute. */
const invocations = [...executable.matchAll(/\baws\s+([a-z0-9-]+)\s+([a-z0-9-]+)/g)].map((m) => ({
  service: m[1],
  verb: m[2],
}));

describe("post-apply verification is read-only", () => {
  it("calls AWS at all, so the checks below are not vacuous", () => {
    expect(invocations.length).toBeGreaterThanOrEqual(8);
  });

  it("uses only describe/list/get/head verbs", () => {
    const readOnly = /^(describe|list|get|head)-/;
    const mutating = invocations.filter((i) => !readOnly.test(i.verb));
    expect(mutating).toEqual([]);
  });

  it("never invokes the Lambda, drives Lex, or changes Connect", () => {
    // Named explicitly because each of these is a specific thing the
    // qualification plan forbids at this stage.
    for (const forbidden of [
      "lambda invoke",
      "lexv2-runtime",
      "recognize-text",
      "recognize-utterance",
      "start-conversation",
      "associate-bot",
      "disassociate-bot",
      "associate-phone-number-contact-flow",
      "update-phone-number",
      "put-instance-storage-config",
      "update-contact-flow",
      "claim-phone-number",
      "release-phone-number",
      "start-outbound-voice-contact",
    ]) {
      expect(executable).not.toContain(forbidden);
    }
  });

  it("never places a call or reaches CALL-E", () => {
    for (const forbidden of ["curl", "wget", "api.calle", "/v1/calls", "CALLE_API_KEY"]) {
      expect(executable).not.toContain(forbidden);
    }
  });

  it("takes resource identifiers from Terraform outputs, not from wildcard discovery", () => {
    for (const output of [
      "supplier_simulator_function_name",
      "lex_bot_id",
      "lex_bot_alias_id",
      "contact_flow_id",
    ]) {
      expect(script).toContain(`tf_output ${output}`);
    }
  });

  it("checks every property the runbook promises it checks", () => {
    for (const probe of [
      "get-function-configuration", // Lambda exists
      "nodejs22.x", // runtime pinned
      "SIMULATOR_ENABLED", // armed state matches the deployment input
      "get-function-concurrency", // concurrency still bounded
      "describe-bot", // Lex bot exists
      "en_US", // locale built
      "describe-bot-alias", // qualification alias exists
      "botVersion", // alias points at a numbered version
      "get-policy", // Lex may invoke the function
      "lexv2.amazonaws.com",
      "describe-contact-flow", // StockGuard flow exists
      "CALL_RECORDINGS", // no recording config when not requested
    ]) {
      expect(script).toContain(probe);
    }
  });

  it("does not claim to verify the phone number's contact-flow association", () => {
    // No AWS API exposes it: describe-phone-number returns TargetArn, which
    // identifies the Connect instance, not the inbound contact flow. Comparing
    // the two is a check that can never fail - a vacuous PASS that reads as
    // evidence while proving nothing.
    // Checked against the parsed AWS invocations, not the raw text: the
    // explanatory `manual` message legitimately names the API it cannot use.
    expect(invocations.filter((i) => i.verb.includes("phone-number"))).toEqual([]);
    expect(executable).not.toContain("TargetArn");
    expect(executable).not.toMatch(/pass ".*bound to the StockGuard flow/);
    expect(executable).not.toMatch(/pass ".*phone/i);
  });

  it("reports the phone-number association as needing a human instead", () => {
    expect(executable).toMatch(/manual "phone number -> contact flow association cannot be read/);
    // A MANUAL item is neither a pass nor a failure, and is counted so the
    // closing summary cannot read as a clean bill of health.
    expect(executable).toContain("MANUAL_CHECKS=$((MANUAL_CHECKS + 1))");
    expect(executable).toContain('if [ "$MANUAL_CHECKS" -gt 0 ]');
    expect(executable).toContain("are NOT verified by this script");
    // The script still exits 0 on manual items alone; only real failures fail.
    expect(executable).toContain("Automated checks passed.");
  });

  it("points at the runbook step that covers the manual check", () => {
    expect(script).toContain("docs/aws-qualification-post-apply-runbook.md step 3");
  });

  it("refuses to run without explicit inputs rather than guessing", () => {
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("--outputs is required");
    expect(script).toContain("--instance-id is required");
  });

  it("does not print the contact flow body, which embeds the account id", () => {
    // The flow content contains the Lex alias ARN. Only Name and Type are read.
    expect(executable).toContain("ContactFlow Name");
    expect(executable).not.toContain("ContactFlow Content");
  });
});
