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

set -euo pipefail
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

# The digest goes to AWS over stdin too: --secret-string on the command line
# would put it in the process list.
if [ "$ROTATE" = "true" ]; then
  printf '%s' "$DIGEST" | aws secretsmanager put-secret-value \
    --region "$REGION" --secret-id "$SECRET_NAME" \
    --secret-string file:///dev/stdin >/dev/null
  echo "rotated $SECRET_NAME"
  echo
  echo "NOTE: rotating the code changes every judge's rate-limit identity,"
  echo "because it is derived from this digest. Existing sessions keep working"
  echo "until they expire."
else
  printf '%s' "$DIGEST" | aws secretsmanager create-secret \
    --region "$REGION" --name "$SECRET_NAME" \
    --description "PBKDF2-SHA256 digest of the StockGuard judge access code." \
    --secret-string file:///dev/stdin >/dev/null
  echo "created $SECRET_NAME"
fi
unset DIGEST

echo
echo "Give the plaintext code to the judges. It exists nowhere else."
