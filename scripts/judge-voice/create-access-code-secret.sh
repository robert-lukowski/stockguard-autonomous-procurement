#!/usr/bin/env bash
#
# Step 0: create the judge access-code secret.
#
# Derives a PBKDF2-SHA256 digest of the access code and stores THE DIGEST in
# Secrets Manager. The plaintext code never reaches AWS, never reaches this
# repository, and never reaches a log.
#
# The code is read from a TTY prompt rather than an argument, because an
# argument lands in shell history and in the process list where any other user
# on the machine can read it.
#
# USAGE
#   scripts/judge-voice/create-access-code-secret.sh [--region eu-central-1]
#
# Run once. To rotate the code later, re-run with --rotate.

# Even `bash -x` / `bash -v` must not log the code or its digest.
set +xv
set -euo pipefail
set +a
umask 077
export AWS_PAGER=""

REGION="${AWS_REGION:-eu-central-1}"
SECRET_NAME="stockguard/judge/access-code"
ROTATE="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --secret-name) SECRET_NAME="${2:?--secret-name needs a value}"; shift 2 ;;
    --rotate) ROTATE="true"; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unrecognized argument: $1" >&2; exit 2 ;;
  esac
done

command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }

# A pipe or a CI runner has no TTY, and a secret typed into one is a secret in
# a log. Refuse rather than fall back to reading stdin.
[ -t 0 ] || { echo "refusing to read an access code without a terminal" >&2; exit 1; }

# Clear inherited export attributes before reading any plaintext.
unset ACCESS_CODE ACCESS_CODE_AGAIN DIGEST
DIGEST_FILE=""
cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "$DIGEST_FILE" ]; then
    rm -f -- "$DIGEST_FILE" || status=1
  fi
  unset ACCESS_CODE ACCESS_CODE_AGAIN DIGEST
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Judge access code (not echoed): '
read -rs ACCESS_CODE
printf '\n'
printf 'Repeat it: '
read -rs ACCESS_CODE_AGAIN
printf '\n'

[ -n "$ACCESS_CODE" ] || { echo "empty access code" >&2; exit 1; }
[ "$ACCESS_CODE" = "$ACCESS_CODE_AGAIN" ] || { echo "the two entries differ" >&2; exit 1; }
[ "${#ACCESS_CODE}" -ge 12 ] || {
  echo "use at least 12 characters: this code is the only credential" >&2
  exit 1
}

# The code is passed to node on stdin, not as an argument, for the same reason
# it was not accepted as one here.
DIGEST="$(
  printf '%s' "$ACCESS_CODE" | node -e '
    const { pbkdf2Sync, randomBytes } = require("node:crypto");
    let code = "";
    process.stdin.on("data", (chunk) => { code += chunk; });
    process.stdin.on("end", () => {
      const salt = randomBytes(16);
      const iterations = 210000;
      process.stdout.write(JSON.stringify({
        algorithm: "PBKDF2-SHA256",
        saltBase64: salt.toString("base64"),
        derivedKeyBase64: pbkdf2Sync(code, salt, iterations, 32, "sha256").toString("base64"),
        iterations,
      }));
    });
  '
)"
unset ACCESS_CODE ACCESS_CODE_AGAIN

# Native Windows AWS CLI cannot read Git Bash's /dev/stdin. mktemp creates
# an exclusive, private file; only the digest ever goes into it. EXIT also
# removes it on an AWS/path-conversion failure or a handled signal.
DIGEST_FILE="$(mktemp "${TMPDIR:-/tmp}/stockguard-judge-access-code.XXXXXXXXXX")"

# AWS needs a native path on Windows, including when TMPDIR contains spaces.
# Keep the POSIX path for shell cleanup and the native path only for AWS.
AWS_DIGEST_FILE="$DIGEST_FILE"
case "${OSTYPE:-}" in
  msys*|cygwin*)
    AWS_DIGEST_FILE="$(cygpath -m "$DIGEST_FILE")"
    # MSYS umask does not restrict inherited Windows ACLs. Protect the empty
    # file first; a failure must abort before any digest is written.
    WINDOWS_SID="$(powershell.exe -NoProfile -NonInteractive -Command \
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value')"
    WINDOWS_SID="${WINDOWS_SID//$'\r'/}"
    MSYS_NO_PATHCONV=1 icacls.exe "$AWS_DIGEST_FILE" \
      /inheritance:r /grant:r "*$WINDOWS_SID:F" >/dev/null
    ;;
esac
printf '%s' "$DIGEST" > "$DIGEST_FILE"
unset DIGEST

if [ "$ROTATE" = "true" ]; then
  aws secretsmanager put-secret-value \
    --region "$REGION" --secret-id "$SECRET_NAME" \
    --secret-string "file://$AWS_DIGEST_FILE" >/dev/null
  echo "rotated $SECRET_NAME"
  echo
  echo "NOTE: rotating the code changes every judge's rate-limit identity,"
  echo "because it is derived from this digest. Existing sessions keep working"
  echo "until they expire."
else
  aws secretsmanager create-secret \
    --region "$REGION" --name "$SECRET_NAME" \
    --description "PBKDF2-SHA256 digest of the StockGuard judge access code." \
    --secret-string "file://$AWS_DIGEST_FILE" >/dev/null
  echo "created $SECRET_NAME"
fi
echo
echo "Give the plaintext code to the judges. It exists nowhere else."
