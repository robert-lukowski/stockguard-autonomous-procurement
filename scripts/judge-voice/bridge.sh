#!/usr/bin/env bash
#
# The manual bridge: associate the Lex alias with the Connect instance.
#
# One step, because it is the only thing Terraform genuinely cannot do —
# aws_connect_bot_association is Lex V1 only
# (hashicorp/terraform-provider-aws#30869). Amazon Connect validates a contact
# flow against this association AT CREATION TIME, so Stage B fails with
# InvalidContactFlowException if this has not run. That has already happened
# twice on the supplier flow.
#
# The command is idempotent: re-running it for an already-associated alias is
# harmless.
#
# USAGE
#   scripts/judge-voice/bridge.sh --instance-id "$AWS_CONNECT_INSTANCE_ID"

set -euo pipefail
export AWS_PAGER=""

REGION="${AWS_REGION:-eu-central-1}"
INSTANCE_ID="${AWS_CONNECT_INSTANCE_ID:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --instance-id) INSTANCE_ID="${2:?--instance-id needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unrecognized argument: $1" >&2; exit 2 ;;
  esac
done

command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }
command -v terraform >/dev/null || { echo "terraform not found" >&2; exit 1; }
[ -n "$INSTANCE_ID" ] || { echo "pass --instance-id or set AWS_CONNECT_INSTANCE_ID" >&2; exit 1; }

cd "$(dirname "$0")/../../infrastructure/terraform"

ALIAS_ARN="$(terraform output -raw judge_lex_bot_alias_arn 2>/dev/null || echo "")"
[ -n "$ALIAS_ARN" ] || {
  echo "no judge_lex_bot_alias_arn output. Run Stage A first." >&2
  exit 1
}

echo "==> associating $ALIAS_ARN"
aws connect associate-bot --region "$REGION" \
  --instance-id "$INSTANCE_ID" \
  --lex-v2-bot "AliasArn=$ALIAS_ARN" \
  2>&1 | grep -v 'ResourceConflictException' || true

echo
echo "==> verifying the association"
# Read it back rather than trusting the command's exit code: an idempotent
# re-run and a genuine failure can look similar, and Stage B depends on this
# being true, not on it having been attempted.
if aws connect list-bots --region "$REGION" \
  --instance-id "$INSTANCE_ID" --lex-version V2 --output text \
  | grep -qF "$ALIAS_ARN"; then
  echo "  PASS  the judge alias is associated with the Connect instance"
  echo
  echo "Next: scripts/judge-voice/stage-b.sh"
  exit 0
fi

echo "  FAIL  the alias does not appear in list-bots" >&2
echo >&2
echo "Do NOT run Stage B: it would fail with InvalidContactFlowException." >&2
exit 1
