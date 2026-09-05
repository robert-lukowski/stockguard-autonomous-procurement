#!/usr/bin/env bash
#
# Stage B: the Connect contact flow, and only then StartWebRTCContact.
#
# Refuses to run until the Lex association from the bridge is verifiably in
# place, because Amazon Connect validates a flow against it at creation time
# and the apply would fail half-way otherwise.
#
# After this, the voice path is live and a contact costs money.
#
# USAGE
#   scripts/judge-voice/stage-b.sh --instance-id "$AWS_CONNECT_INSTANCE_ID"

set -euo pipefail
export AWS_PAGER=""

REGION="${AWS_REGION:-eu-central-1}"
INSTANCE_ID="${AWS_CONNECT_INSTANCE_ID:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --instance-id) INSTANCE_ID="${2:?--instance-id needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unrecognized argument: $1" >&2; exit 2 ;;
  esac
done

command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }
command -v terraform >/dev/null || { echo "terraform not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
[ -n "$INSTANCE_ID" ] || { echo "pass --instance-id or set AWS_CONNECT_INSTANCE_ID" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../infrastructure/terraform"

# ---------------------------------------------------------------------------
# The precondition, checked rather than assumed.
# ---------------------------------------------------------------------------
ALIAS_ARN="$(terraform output -raw judge_lex_bot_alias_arn 2>/dev/null || echo "")"
[ -n "$ALIAS_ARN" ] || { echo "no alias output. Run Stage A first." >&2; exit 1; }

if ! aws connect list-bots --region "$REGION" \
  --instance-id "$INSTANCE_ID" --lex-version V2 --output text \
  | grep -qF "$ALIAS_ARN"; then
  echo "REFUSING: the judge Lex alias is not associated with the instance." >&2
  echo "Run scripts/judge-voice/bridge.sh first." >&2
  exit 1
fi
echo "==> the Lex association is in place"

# ---------------------------------------------------------------------------
# Plan, and check its shape before applying.
# ---------------------------------------------------------------------------
echo
echo "==> terraform plan (Stage B)"
# The same instance and region the association was just verified against, so
# the plan cannot target a different one and defeat the guard above.
terraform plan -input=false -out=stage-b.tfplan \
  -var "aws_region=$REGION" \
  -var "connect_instance_id=$INSTANCE_ID" \
  -var 'webrtc_judge_mode_enabled=true' \
  -var 'procurement_table_enabled=true' \
  -var 'connect_judge_flow_enabled=true'

# Stage B should create the flow and update the session Lambda in place.
# planGuard rejects any action array containing "delete", so a REPLACEMENT
# (["delete","create"]) is caught too - destroying a live API to recreate it
# is not something to wave through on the way to a demo.
echo
terraform show -json stage-b.tfplan | node "$SCRIPT_DIR/planGuard.mjs" stage-b

echo
echo "After this apply the voice path is LIVE. Each judge session starts a"
echo "billable Amazon Connect voice contact."
printf 'Type APPLY to continue: '
read -r CONFIRM
[ "$CONFIRM" = "APPLY" ] || { echo "not applying"; exit 1; }

echo
echo "==> terraform apply"
terraform apply -input=false stage-b.tfplan

# ---------------------------------------------------------------------------
# Verify, without starting a contact. Starting one here would cost money and
# would leave a consumed single-use grant on a session no judge is using.
# ---------------------------------------------------------------------------
echo
echo "==> verifying Stage B"
FLOW_ID="$(terraform output -raw judge_voice_flow_id 2>/dev/null || echo "")"
if [ -n "$FLOW_ID" ] && [ "$FLOW_ID" != "null" ]; then
  echo "  PASS  contact flow $FLOW_ID exists"
else
  echo "  FAIL  judge_voice_flow_id is empty" >&2
  exit 1
fi

echo
echo "Set these three PUBLIC repository variables, then re-run Deploy Pages:"
echo
echo "  WEBRTC_JUDGE_MODE   true"
echo "  WEBRTC_SESSION_URL  $(terraform output -raw voice_session_endpoint | sed 's:/*$::')/voice-sessions"
echo "  JUDGE_LOGIN_URL     $(terraform output -raw judge_login_endpoint)"
echo
echo "Never put the access code, a session token or an AWS credential in a"
echo "Pages variable: the built bundle is public."
echo
echo "Then run the demo yourself before handing it to a judge:"
echo "  sign in, Start Voice Demo, allow the microphone, and say"
echo '  "I need twenty industrial SSD drives within a week."'
