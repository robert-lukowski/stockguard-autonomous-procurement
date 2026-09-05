#!/usr/bin/env bash
#
# Roll the voice path back, in the safe order.
#
#   --voice-off   removes the contact flow and the StartWebRTCContact grant.
#                 No contact can be started after this. Everything else keeps
#                 working, so it is the right first move if something is wrong
#                 mid-demo.
#   --all         additionally removes the API, all four Lambdas and the Lex
#                 bot.
#
# The DynamoDB table is NEVER destroyed by this script, and Terraform will
# refuse to anyway: it carries prevent_destroy and deletion_protection_enabled.
# It holds consumed single-use tokens and audit chains, so removing it is a
# deliberate manual act, not a rollback step.
#
# USAGE
#   scripts/judge-voice/rollback.sh --voice-off --instance-id "$AWS_CONNECT_INSTANCE_ID"
#   scripts/judge-voice/rollback.sh --all      --instance-id "$AWS_CONNECT_INSTANCE_ID"

set -euo pipefail
export AWS_PAGER=""

MODE=""
REGION="${AWS_REGION:-eu-central-1}"
INSTANCE_ID="${AWS_CONNECT_INSTANCE_ID:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --voice-off) MODE="voice-off"; shift ;;
    --all) MODE="all"; shift ;;
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --instance-id) INSTANCE_ID="${2:?--instance-id needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "unrecognized argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$MODE" ] || { echo "pass --voice-off or --all" >&2; exit 2; }
command -v terraform >/dev/null || { echo "terraform not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
[ -n "$INSTANCE_ID" ] || { echo "pass --instance-id or set AWS_CONNECT_INSTANCE_ID" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../infrastructure/terraform"

if [ "$MODE" = "voice-off" ]; then
  echo "==> planning: contact flow and StartWebRTCContact removed, rest intact"
  terraform plan -input=false -out=rollback.tfplan \
    -var "aws_region=$REGION" \
    -var "connect_instance_id=$INSTANCE_ID" \
    -var 'webrtc_judge_mode_enabled=true' \
    -var 'procurement_table_enabled=true' \
    -var 'connect_judge_flow_enabled=false'
else
  echo "==> planning: the whole voice stack removed"
  echo "    (the DynamoDB table stays: prevent_destroy and deletion protection)"
  terraform plan -input=false -out=rollback.tfplan \
    -var "aws_region=$REGION" \
    -var "connect_instance_id=$INSTANCE_ID" \
    -var 'webrtc_judge_mode_enabled=false' \
    -var 'procurement_table_enabled=true'
fi

# The table must survive either mode. planGuard checks the table's own change
# entry rather than pattern-matching across the serialized plan, where a `.*`
# spans the whole single-line document and matches things that are nowhere
# near each other.
echo
terraform show -json rollback.tfplan | node "$SCRIPT_DIR/planGuard.mjs" rollback

echo
printf 'Review the plan above. Type ROLLBACK to continue: '
read -r CONFIRM
[ "$CONFIRM" = "ROLLBACK" ] || { echo "not applying"; exit 1; }

terraform apply -input=false rollback.tfplan

echo
if [ "$MODE" = "voice-off" ]; then
  echo "Voice is off. Sign-in still works; no contact can be started."
else
  echo "The voice stack is gone. The procurement table remains."
fi
echo
echo "Also set the WEBRTC_JUDGE_MODE repository variable to anything but"
echo "'true' and re-run Deploy Pages, so the portal stops offering voice."
