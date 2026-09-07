import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const windows = process.platform === "win32";
const gitExecPath = windows
  ? spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim()
  : "";
const bash = windows ? resolve(gitExecPath, "../../../bin/bash.exe") : "bash";
const target = resolve(__dirname, "create-access-code-secret.sh").replaceAll("\\", "/");
const fixtures: string[] = [];
// This is a public test fixture, never a real judge credential.
const testCode = "regression-only 123! back\\slash";

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function run(options: { rotate?: boolean; mode?: string; os?: string; traced?: boolean; tty?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "judge secret test "));
  fixtures.push(directory);
  const nativeDirectory = directory.replaceAll("\\", "/");
  const record = join(directory, "aws-record.json");
  writeFileSync(join(directory, "aws.cjs"), `
const fs = require("node:fs");
const { pbkdf2Sync } = require("node:crypto");
const args = process.argv.slice(2);
const uri = args[args.indexOf("--secret-string") + 1];
// Native Windows AWS CLI cannot open the MSYS /dev/stdin pseudo-file.
if (!uri?.startsWith("file://") || uri === "file:///dev/stdin") process.exit(91);
const file = uri.slice(7);
const raw = fs.readFileSync(file, "utf8");
const digest = JSON.parse(raw);
const expected = pbkdf2Sync(${JSON.stringify(testCode)}, Buffer.from(digest.saltBase64, "base64"), 210000, 32, "sha256").toString("base64");
fs.writeFileSync(process.env.TEST_RECORD, JSON.stringify({
  args, file, mode: fs.statSync(file).mode & 0o777,
  algorithm: digest.algorithm, iterations: digest.iterations,
  saltLength: Buffer.from(digest.saltBase64, "base64").length,
  verified: digest.derivedKeyBase64 === expected,
  leaked: raw.includes(${JSON.stringify(testCode)}) || args.some(arg => arg.includes(${JSON.stringify(testCode)})),
  exported: ["ACCESS_CODE", "ACCESS_CODE_AGAIN", "DIGEST"].filter(name => process.env[name] !== undefined),
}));
`);
  // Only the TTY predicate is simulated: the production reads, hashing,
  // file creation, AWS arguments and traps all execute without rewriting them.
  writeFileSync(join(directory, "harness.sh"), `
# Avoid Git Bash's automatic conversion of the inherited TMPDIR value when
# exercising the Linux/macOS branch with native Windows node as the AWS stub.
TMPDIR="$TEST_DIR"
if [ "$TEST_TTY" = yes ]; then
  [() {
    if builtin [ "$#" -eq 3 ] && builtin [ "$1" = -t ] && builtin [ "$2" = 0 ]; then
      return 0
    fi
    builtin [ "$@"
  }
fi
cygpath() {
  printf 'converted\\n' >> "$TEST_DIR/conversion"
  if [ "$TEST_MODE" = conversion-failure ]; then return 43; fi
  if [ "$TEST_WINDOWS" = yes ]; then command cygpath "$@"; else printf '%s\\n' "$2"; fi
}
powershell.exe() {
  if [ "$TEST_WINDOWS" = yes ]; then command powershell.exe "$@"; else printf 'S-1-5-21-0-0-0-1000\\n'; fi
}
icacls.exe() {
  # Permission setup must happen while the temporary file is still empty.
  [ ! -s "$1" ] || return 47
  if [ "$TEST_MODE" = acl-failure ]; then return 46; fi
  if [ "$TEST_WINDOWS" = yes ]; then
    command icacls.exe "$@" || return $?
    if [ "$TEST_MODE" = inspect-acl ]; then
      export TEST_DIGEST_FILE="$1"
      command powershell.exe -NoProfile -NonInteractive -Command '
        $acl = Get-Acl -LiteralPath $env:TEST_DIGEST_FILE
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $entries = @($acl.Access)
        if ($entries.Count -ne 1 -or $entries[0].IsInherited -or $entries[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid -or $entries[0].AccessControlType -ne "Allow" -or $entries[0].FileSystemRights -ne "FullControl") { exit 48 }
      ' || return $?
    fi
  fi
}
mktemp() {
  if [ "$TEST_MODE" = mktemp-failure ]; then return 44; fi
  command mktemp "$@"
}
node() {
  if [ "$TEST_MODE" = hash-failure ]; then return 45; fi
  command node "$@"
}
aws() {
  command node "$TEST_DIR/aws.cjs" "$@" || return $?
  case "$TEST_MODE" in
    aws-failure) return 42 ;;
    HUP|INT|TERM) kill -s "$TEST_MODE" "$$" ;;
  esac
}
export ACCESS_CODE=inherited ACCESS_CODE_AGAIN=inherited DIGEST=inherited
. "$TEST_TARGET" "$@"
`);
  const result = spawnSync(bash, [
    ...(options.traced ? ["-xva"] : []),
    join(directory, "harness.sh"),
    "--region", "eu-central-1", "--secret-name", "test/judge",
    ...(options.rotate ? ["--rotate"] : []),
  ], {
    encoding: "utf8",
    input: `${testCode}\n${testCode}\n`,
    timeout: 30000,
    env: {
      ...process.env,
      TMPDIR: nativeDirectory,
      OSTYPE: options.os ?? (windows ? "msys" : "linux-gnu"),
      TEST_DIR: nativeDirectory,
      TEST_TARGET: target,
      TEST_RECORD: record,
      TEST_TTY: options.tty === false ? "no" : "yes",
      TEST_WINDOWS: windows ? "yes" : "no",
      TEST_MODE: options.mode ?? "success",
    },
  });
  expect(result.error).toBeUndefined();
  expect(`${result.stdout}${result.stderr}`).not.toContain(testCode);
  expect(readdirSync(directory).filter(name => name.startsWith("stockguard-judge-access-code."))).toEqual([]);
  return {
    ...result,
    files: readdirSync(directory),
    record: readdirSync(directory).includes("aws-record.json")
      ? JSON.parse(readFileSync(record, "utf8"))
      : undefined,
  };
}

describe("access-code secret file transport", () => {
  it.each([false, true])("passes only a readable digest file to native AWS (rotate=%s)", (rotate) => {
    const result = run({ rotate });
    expect(result.status, result.stderr).toBe(0);
    expect(result.record).toMatchObject({
      algorithm: "PBKDF2-SHA256", iterations: 210000, saltLength: 16,
      verified: true, leaked: false, exported: [],
    });
    expect(result.record.args.slice(0, 2)).toEqual([
      "secretsmanager", rotate ? "put-secret-value" : "create-secret",
    ]);
    expect(result.record.args).toContain(rotate ? "--secret-id" : "--name");
    expect(result.record.args).toContain("test/judge");
    expect(result.record.args).toContain("eu-central-1");
    expect(result.stdout).toContain(rotate ? "rotated test/judge" : "created test/judge");
    if (!windows) expect(result.record.mode).toBe(0o600);
    if (windows) expect(result.record.file).toMatch(/^[A-Za-z]:\//);
  });

  it.each(["msys", "cygwin", "linux-gnu", "darwin23"])("handles %s paths with spaces", (os) => {
    const result = run({ os });
    expect(result.status, result.stderr).toBe(0);
    expect(result.record.verified).toBe(true);
    expect(result.files.includes("conversion")).toBe(os === "msys" || os === "cygwin");
  });

  it.each([false, true])("removes the digest when AWS fails (rotate=%s)", (rotate) => {
    const result = run({ rotate, mode: "aws-failure" });
    expect(result.status).toBe(42);
    expect(result.record.verified).toBe(true);
    expect(result.stdout).not.toMatch(/created test|rotated test/);
  });

  it.each([["HUP", 129], ["INT", 130], ["TERM", 143]] as const)("cleans up on %s", (mode, status) => {
    const result = run({ mode });
    expect(result.status).toBe(status);
    expect(result.record.verified).toBe(true);
  });

  it.each([["conversion-failure", 43], ["mktemp-failure", 44], ["hash-failure", 45], ["acl-failure", 46]] as const)(
    "stops without AWS and leaves no digest after %s", (mode, status) => {
      const result = run({ mode, os: "msys" });
      expect(result.status).toBe(status);
      expect(result.record).toBeUndefined();
    },
  );

  it.runIf(windows)("limits the actual Windows file ACL to the current user before writing", () => {
    const result = run({ mode: "inspect-acl" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.record.verified).toBe(true);
  });

  it("disables inherited tracing and automatic exports before reading the code", () => {
    const result = run({ traced: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.record.exported).toEqual([]);
    expect(result.stderr).not.toContain("derivedKeyBase64");
  });

  it("refuses a real non-TTY input before calling AWS", () => {
    const result = run({ tty: false });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to read an access code without a terminal");
    expect(result.record).toBeUndefined();
  });
});
