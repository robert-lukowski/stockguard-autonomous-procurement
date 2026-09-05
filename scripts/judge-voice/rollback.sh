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
#   scripts/judge-voice/rollback.sh --voice-off
#   scripts/judge-voice/rollback.sh --all

set -euo pipefail
export AWS_PAGER=""

MODE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --voice-off) MODE="voice-off"; shift ;;
    --all) MODE="all"; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "unrecognized argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$MODE" ] || { echo "pass --voice-off or --all" >&2; exit 2; }
command -v terraform >/dev/null || { echo "terraform not found" >&2; exit 1; }

cd "$(dirname "$0")/../../infrastructure/terraform"

if [ "$MODE" = "voice-off" ]; then
  echo "==> planning: contact flow and StartWebRTCContact removed, rest intact"
  terraform plan -input=false -out=rollback.tfplan \
    -var 'webrtc_judge_mode_enabled=true' \
    -var 'procurement_table_enabled=true' \
    -var 'connect_judge_flow_enabled=false'
else
  echo "==> planning: the whole voice stack removed"
  echo "    (the DynamoDB table stays: prevent_destroy and deletion protection)"
  terraform plan -input=false -out=rollback.tfplan \
    -var 'webrtc_judge_mode_enabled=false' \
    -var 'procurement_table_enabled=true'
fi

# The table must survive either mode. If a plan proposes destroying it,
# something is wrong with the configuration, not with this rollback.
if terraform show -json rollback.tfplan \
  | grep -q '"type":"aws_dynamodb_table".*"actions":\["delete"\]'; then
  echo >&2
  echo "REFUSING: this plan would destroy the procurement table." >&2
  echo "It holds consumed single-use tokens and audit chains." >&2
  exit 1
fi

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
