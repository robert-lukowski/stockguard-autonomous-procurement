#!/usr/bin/env bash
#
# Stage A: everything except Amazon Connect.
#
# Builds the Lambda bundles, plans, shows you the plan, applies only after you
# type APPLY, then VERIFIES the result — including the one assertion that
# proves Stage A is correctly incomplete: an authenticated caller gets
# 409 DISABLED because no contact flow exists yet.
#
# That verification matters more than it looks. Two of the defects found in
# review were invisible to the whole test suite AND to terraform validate, and
# would have surfaced only here. A green CI run does not tell you this works.
#
# USAGE
#   scripts/judge-voice/stage-a.sh --instance-id "$AWS_CONNECT_INSTANCE_ID"
#
# --instance-id is required: var.connect_instance_id has no default, so a plan
# without it either fails under -input=false or silently uses whatever a
# tfvars file happens to hold. It is passed to Terraform explicitly so the
# instance this script targets is the instance it deploys to.
#
# The access code is read from a file (or a TTY prompt) so it never lands in
# shell history or the process list.

set -euo pipefail
export AWS_PAGER=""

REGION="${AWS_REGION:-eu-central-1}"
INSTANCE_ID="${AWS_CONNECT_INSTANCE_ID:-}"
ACCESS_CODE_FILE=""
SKIP_BUILD="false"
TF_DIR="infrastructure/terraform"

while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --instance-id) INSTANCE_ID="${2:?--instance-id needs a value}"; shift 2 ;;
    --access-code-file) ACCESS_CODE_FILE="${2:?--access-code-file needs a path}"; shift 2 ;;
    --skip-build) SKIP_BUILD="true"; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unrecognized argument: $1" >&2; exit 2 ;;
  esac
done

command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }
command -v terraform >/dev/null || { echo "terraform not found" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
[ -n "$INSTANCE_ID" ] || { echo "pass --instance-id or set AWS_CONNECT_INSTANCE_ID" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

FAILURES=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# ---------------------------------------------------------------------------
# 1. Bundles. terraform plan reads them from disk and fails if they are absent.
# ---------------------------------------------------------------------------
if [ "$SKIP_BUILD" = "false" ]; then
  echo "==> building Lambda bundles"
  npm run build:lambda >/dev/null
fi
for bundle in judgeLogin judgeAuthorizer judgeVoice voiceSession; do
  [ -f "$TF_DIR/build/$bundle/index.js" ] || {
    echo "missing bundle: $TF_DIR/build/$bundle/index.js" >&2
    echo "run: npm run build:lambda" >&2
    exit 1
  }
done
echo "    four bundles present"

# ---------------------------------------------------------------------------
# 2. Plan, and read it before applying.
# ---------------------------------------------------------------------------
cd "$TF_DIR"
echo
echo "==> terraform init"
terraform init -input=false >/dev/null

echo
echo "==> terraform plan (Stage A)"
terraform plan -input=false -out=stage-a.tfplan \
  -var "aws_region=$REGION" \
  -var "connect_instance_id=$INSTANCE_ID" \
  -var 'webrtc_judge_mode_enabled=true' \
  -var 'procurement_table_enabled=true'

# planGuard reads resource_changes, not planned_values. The difference matters:
# planned_values lists the whole resulting state, including the unconditional
# supplier contact flow in connect.tf, so inspecting it would refuse every
# valid Stage A plan.
echo
terraform show -json stage-a.tfplan | node "$SCRIPT_DIR/planGuard.mjs" stage-a

echo
printf 'Review the plan above. Type APPLY to continue: '
read -r CONFIRM
[ "$CONFIRM" = "APPLY" ] || { echo "not applying"; exit 1; }

echo
echo "==> terraform apply"
terraform apply -input=false stage-a.tfplan

# ---------------------------------------------------------------------------
# 3. Verify. This is the part worth having.
# ---------------------------------------------------------------------------
LOGIN_URL="$(terraform output -raw judge_login_endpoint)"
API_URL="$(terraform output -raw voice_session_endpoint)"
BOT_ID="$(terraform output -raw judge_lex_bot_id)"
VOICE_URL="${API_URL%/}/voice-sessions"
cd - >/dev/null

echo
echo "==> verifying Stage A"

LOCALE_STATUS="$(
  aws lexv2-models describe-bot-locale --region "$REGION" \
    --bot-id "$BOT_ID" --bot-version DRAFT --locale-id en_US \
    --query botLocaleStatus --output text 2>/dev/null || echo "UNREADABLE"
)"
if [ "$LOCALE_STATUS" = "Built" ]; then
  pass "Lex locale is Built"
else
  fail "Lex locale is '$LOCALE_STATUS', expected Built"
fi

# The access code, from a file or a prompt. Never an argument.
if [ -n "$ACCESS_CODE_FILE" ]; then
  ACCESS_CODE="$(cat "$ACCESS_CODE_FILE")"
elif [ -t 0 ]; then
  printf 'Judge access code (not echoed): '
  read -rs ACCESS_CODE
  printf '\n'
else
  echo "no access code available; pass --access-code-file" >&2
  exit 1
fi

# The body is built by node so the code is JSON-escaped correctly, and passed
# to curl on stdin so it never appears in the process list.
SIGN_IN_BODY="$(printf '%s' "$ACCESS_CODE" | node -e '
  let code = "";
  process.stdin.on("data", (chunk) => { code += chunk; });
  process.stdin.on("end", () => process.stdout.write(JSON.stringify({ accessCode: code })));
')"
unset ACCESS_CODE

TOKEN="$(
  printf '%s' "$SIGN_IN_BODY" \
    | curl -sS -X POST "$LOGIN_URL" -H 'content-type: application/json' --data-binary @- \
    | node -e '
        let body = "";
        process.stdin.on("data", (chunk) => { body += chunk; });
        process.stdin.on("end", () => {
          try {
            const token = JSON.parse(body).token;
            process.stdout.write(typeof token === "string" ? token : "");
          } catch {
            process.stdout.write("");
          }
        });
      ' || echo ""
)"
unset SIGN_IN_BODY
if printf '%s' "$TOKEN" | grep -Eq '^[0-9a-f]{64}$'; then
  pass "sign-in issued a 64-hex opaque token"
else
  fail "sign-in did not issue a token"
fi

WRONG_CODE_STATUS="$(
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$LOGIN_URL" \
    -H 'content-type: application/json' -d '{"accessCode":"definitely-wrong"}' || echo "000"
)"
[ "$WRONG_CODE_STATUS" = "401" ] \
  && pass "a wrong access code is refused (401)" \
  || fail "a wrong access code returned $WRONG_CODE_STATUS, expected 401"

ANON_STATUS="$(
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$VOICE_URL" \
    -H 'content-type: application/json' -d '{"missionId":"MISSION-SSD-20"}' || echo "000"
)"
[ "$ANON_STATUS" = "401" ] \
  && pass "the voice route rejects an unauthenticated call (401)" \
  || fail "an unauthenticated voice call returned $ANON_STATUS, expected 401"

# THE assertion. Authenticated, reaches the Lambda, and is refused because
# Stage B has not run. Anything else means the stage gate is not holding.
if [ -n "$TOKEN" ]; then
  AUTHED_BODY="$(
    curl -sS -X POST "$VOICE_URL" \
      -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d '{"missionId":"MISSION-SSD-20"}' || echo '{}'
  )"
  if printf '%s' "$AUTHED_BODY" | grep -q '"reason":"DISABLED"'; then
    pass "an authenticated call is refused DISABLED — no contact can start yet"
  else
    fail "expected reason DISABLED, got: $AUTHED_BODY"
  fi
fi
unset TOKEN

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "Stage A is complete and correctly incomplete: sign-in works, no contact can start."
  echo
  echo "Next: scripts/judge-voice/bridge.sh"
  exit 0
fi
echo "$FAILURES check(s) failed. Do NOT run the bridge or Stage B." >&2
exit 1
