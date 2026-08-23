#!/usr/bin/env bash
#
# Post-apply verification for the StockGuard qualification runtime.
#
# READ-ONLY. Every AWS call below is a describe/list/get. This script never
# invokes the Lambda, never starts a Lex conversation, never modifies Connect,
# never associates a bot, never touches the telephone number and never calls
# CALL-E. `verifyAwsRuntime.test.ts` enforces that mechanically by rejecting
# any mutating verb in this file, so the property survives future edits.
#
# It answers one question: did the apply produce the runtime we intended, and
# nothing else?
#
# USAGE
#   cd infrastructure/terraform && terraform output -json > /tmp/outputs.json
#   scripts/qualification/verifyAwsRuntime.sh --outputs /tmp/outputs.json \
#     --instance-id "$AWS_CONNECT_INSTANCE_ID" --expect-simulator false
#
# Resource identifiers come from Terraform outputs rather than from wildcard
# discovery, so this cannot accidentally report on somebody else's resources.

set -euo pipefail
export AWS_PAGER=""

OUTPUTS_FILE=""
INSTANCE_ID="${AWS_CONNECT_INSTANCE_ID:-}"
EXPECT_SIMULATOR="false"
EXPECT_RECORDING="false"
REGION="${AWS_REGION:-eu-central-1}"

while [ $# -gt 0 ]; do
  case "$1" in
    --outputs) OUTPUTS_FILE="${2:?--outputs needs a path}"; shift 2 ;;
    --instance-id) INSTANCE_ID="${2:?--instance-id needs a value}"; shift 2 ;;
    --expect-simulator) EXPECT_SIMULATOR="${2:?--expect-simulator needs true or false}"; shift 2 ;;
    --expect-recording) EXPECT_RECORDING="${2:?--expect-recording needs true or false}"; shift 2 ;;
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unrecognized argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$OUTPUTS_FILE" ] || { echo "--outputs is required (terraform output -json)" >&2; exit 2; }
[ -r "$OUTPUTS_FILE" ] || { echo "cannot read $OUTPUTS_FILE" >&2; exit 2; }
[ -n "$INSTANCE_ID" ] || { echo "--instance-id is required" >&2; exit 2; }

# --- helpers ---------------------------------------------------------------

FAILURES=0
MANUAL_CHECKS=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
info() { printf '  ..    %s\n' "$1"; }
# Neither a pass nor a failure: something this script genuinely cannot
# determine, which a human must check instead. Counted so it cannot be
# mistaken for a clean bill of health.
manual() { printf '  MANUAL  %s\n' "$1"; MANUAL_CHECKS=$((MANUAL_CHECKS + 1)); }

# Identifiers are operationally useful but do not need to be printed in full.
mask() {
  local v="${1:-}"
  if [ "${#v}" -le 8 ]; then printf '********'; else printf '%s****%s' "${v:0:4}" "${v: -4}"; fi
}

tf_output() {
  python3 -c '
import json,sys
data = json.load(open(sys.argv[1]))
entry = data.get(sys.argv[2])
print("" if entry is None else entry.get("value", ""))
' "$OUTPUTS_FILE" "$1"
}

jget() { python3 -c '
import json,sys
raw = sys.stdin.read().strip()
if not raw:
    # An API that legitimately returns nothing (an absent concurrency
    # reservation, for one) must read as "no value", not crash the run.
    print("")
    sys.exit(0)
try:
    value = json.loads(raw)
except json.JSONDecodeError:
    print("")
    sys.exit(0)
for key in sys.argv[1:]:
    if value is None:
        break
    value = value.get(key) if isinstance(value, dict) else None
print("" if value is None else value)
' "$@"; }

FUNCTION_NAME="$(tf_output supplier_simulator_function_name)"
BOT_ID="$(tf_output lex_bot_id)"
ALIAS_ID="$(tf_output lex_bot_alias_id)"
FLOW_ID="$(tf_output contact_flow_id)"

for pair in "supplier_simulator_function_name:$FUNCTION_NAME" "lex_bot_id:$BOT_ID" \
            "lex_bot_alias_id:$ALIAS_ID" "contact_flow_id:$FLOW_ID"; do
  [ -n "${pair#*:}" ] || { echo "terraform output ${pair%%:*} is empty; apply did not complete" >&2; exit 2; }
done

echo "StockGuard qualification runtime - read-only verification"
echo "  region ${REGION} · expecting simulator=${EXPECT_SIMULATOR}, recording=${EXPECT_RECORDING}"
echo

# --- Lambda ----------------------------------------------------------------

echo "Lambda"
if LAMBDA_CFG="$(aws lambda get-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" 2>/dev/null)"; then
  pass "function exists ($FUNCTION_NAME)"

  RUNTIME="$(printf '%s' "$LAMBDA_CFG" | jget Runtime)"
  [ "$RUNTIME" = "nodejs22.x" ] && pass "runtime is nodejs22.x" || fail "runtime is '${RUNTIME}', expected nodejs22.x"

  SIM="$(printf '%s' "$LAMBDA_CFG" | jget Environment Variables SIMULATOR_ENABLED)"
  if [ "$SIM" = "$EXPECT_SIMULATOR" ]; then
    pass "SIMULATOR_ENABLED=${SIM} matches the deployment input"
  else
    fail "SIMULATOR_ENABLED='${SIM}' but the deployment input was '${EXPECT_SIMULATOR}'"
  fi

  # The alias guard must stay narrow: a widened list would let an unreviewed
  # alias, including the always-DRAFT TestBotAlias, drive the supplier.
  ALIASES="$(printf '%s' "$LAMBDA_CFG" | jget Environment Variables ALLOWED_LEX_ALIAS_NAMES)"
  [ "$ALIASES" = "qualification" ] && pass "alias guard is exactly 'qualification'" \
    || fail "ALLOWED_LEX_ALIAS_NAMES='${ALIASES}', expected exactly 'qualification'"

  # lambda.tf sets `var.simulator_enabled ? -1 : 0`, so the expected value
  # depends on the deployment input:
  #   disarmed -> 0, a reservation of ZERO. The function cannot be invoked at
  #               all, which is the strongest possible disarmed state.
  #   armed    -> -1, meaning no reservation, so the API returns nothing. The
  #               account minimum-unreserved rule makes a positive reservation
  #               impossible here.
  # The old 1-10 bound predates that design and failed a correctly disarmed
  # deployment.
  # An absent reservation and a FAILED read both look like an empty string, and
  # while armed the absent case is a PASS - so a failed read must never reach
  # that branch or it would pass without having verified anything. Keep the
  # call's exit status and treat a failure as a failure.
  if CONCURRENCY_JSON="$(aws lambda get-function-concurrency --region "$REGION" --function-name "$FUNCTION_NAME" 2>/dev/null)"; then
    RESERVED="$(printf '%s' "$CONCURRENCY_JSON" | jget ReservedConcurrentExecutions)"
    if [ "$EXPECT_SIMULATOR" = "false" ]; then
      if [ "$RESERVED" = "0" ]; then
        pass "reserved concurrency is 0 - the function cannot be invoked while disarmed"
      else
        fail "reserved concurrency is '${RESERVED:-unset}' but a disarmed deployment must reserve 0"
      fi
    else
      if [ -z "$RESERVED" ]; then
        pass "no reservation while armed, as configured"
      else
        fail "reserved concurrency is ${RESERVED} but an armed deployment expects no reservation"
      fi
    fi
  else
    fail "could not read reserved concurrency - the disarm state is UNVERIFIED"
  fi

  # Lex must be permitted to invoke; nothing else should be.
  POLICY="$(aws lambda get-policy --region "$REGION" --function-name "$FUNCTION_NAME" 2>/dev/null | jget Policy)"
  case "$POLICY" in
    *lexv2.amazonaws.com*) pass "resource policy allows lexv2.amazonaws.com" ;;
    "") fail "function has no resource policy, so Lex cannot invoke it" ;;
    *) fail "resource policy does not name lexv2.amazonaws.com" ;;
  esac
else
  fail "function ${FUNCTION_NAME} not found"
fi
echo

# --- Lex V2 ----------------------------------------------------------------

echo "Lex V2"
if BOT="$(aws lexv2-models describe-bot --region "$REGION" --bot-id "$BOT_ID" 2>/dev/null)"; then
  pass "bot exists ($(mask "$BOT_ID")), status $(printf '%s' "$BOT" | jget botStatus)"
else
  fail "bot $(mask "$BOT_ID") not found"
fi

if ALIAS="$(aws lexv2-models describe-bot-alias --region "$REGION" --bot-id "$BOT_ID" --bot-alias-id "$ALIAS_ID" 2>/dev/null)"; then
  ALIAS_NAME="$(printf '%s' "$ALIAS" | jget botAliasName)"
  ALIAS_VERSION="$(printf '%s' "$ALIAS" | jget botVersion)"
  ALIAS_STATUS="$(printf '%s' "$ALIAS" | jget botAliasStatus)"
  [ "$ALIAS_NAME" = "qualification" ] && pass "alias is named 'qualification'" \
    || fail "alias is named '${ALIAS_NAME}', expected 'qualification'"
  # A numbered version, never DRAFT: TestBotAlias tracks DRAFT, so runtime
  # behaviour would change the moment anyone edits the bot in the console.
  case "$ALIAS_VERSION" in
    ""|DRAFT) fail "alias points at '${ALIAS_VERSION:-empty}'; it must point at a numbered version" ;;
    *) pass "alias points at bot version ${ALIAS_VERSION}" ;;
  esac
  info "alias status ${ALIAS_STATUS}"

  # The runtime serves the version the ALIAS points at. DRAFT's build state is
  # irrelevant to a call and is reported separately, below, purely as context
  # for anyone editing the bot.
  if [ -n "$ALIAS_VERSION" ] && [ "$ALIAS_VERSION" != "DRAFT" ]; then
    RUNTIME_LOCALE="$(aws lexv2-models describe-bot-locale --region "$REGION" \
      --bot-id "$BOT_ID" --bot-version "$ALIAS_VERSION" --locale-id en_US 2>/dev/null | jget botLocaleStatus)"
    case "$RUNTIME_LOCALE" in
      Built | ReadyExpressTesting)
        pass "locale en_US on served version ${ALIAS_VERSION} is ${RUNTIME_LOCALE}" ;;
      "")
        fail "locale en_US not found on served version ${ALIAS_VERSION}" ;;
      *)
        fail "locale en_US on served version ${ALIAS_VERSION} is ${RUNTIME_LOCALE}, expected Built - the bot cannot answer a call" ;;
    esac
  fi
else
  fail "alias $(mask "$ALIAS_ID") not found"
fi

DRAFT_LOCALE="$(aws lexv2-models describe-bot-locale --region "$REGION" \
  --bot-id "$BOT_ID" --bot-version DRAFT --locale-id en_US 2>/dev/null | jget botLocaleStatus)"
info "DRAFT locale en_US is ${DRAFT_LOCALE:-absent} (build state of DRAFT does not affect a call)"
echo

# --- Connect ---------------------------------------------------------------

echo "Amazon Connect"
if FLOW="$(aws connect describe-contact-flow --region "$REGION" --instance-id "$INSTANCE_ID" --contact-flow-id "$FLOW_ID" 2>/dev/null)"; then
  # Name and type only. The flow body is never printed: it embeds the alias ARN
  # and therefore the account id.
  pass "contact flow exists: $(printf '%s' "$FLOW" | jget ContactFlow Name) ($(printf '%s' "$FLOW" | jget ContactFlow Type))"
else
  fail "contact flow $(mask "$FLOW_ID") not found"
fi

# The phone-number -> inbound contact-flow association is NOT readable through
# any AWS API. `describe-phone-number` returns TargetArn, which identifies the
# Connect instance (or a traffic distribution group) - never the contact flow.
#
# An earlier version of this script compared TargetArn against the flow id and
# reported "no telephone number is bound to the StockGuard flow". That check
# could never fail, because the two values are different kinds of identifier:
# it was a vacuous PASS that would have read as evidence while proving
# nothing. A check that cannot fail is worse than no check, so it is gone.
#
# Terraform does not assign the number - `aws_connect_contact_flow` carries no
# number association and this configuration has no phone-number resource, which
# the plan safety gate independently enforces. But that is an argument from the
# configuration, not an observation of the live instance, so it is not a PASS
# either.
manual "phone number -> contact flow association cannot be read via any AWS API (describe-phone-number returns the instance ARN, not the flow); confirm in the Amazon Connect console - see docs/aws-qualification-post-apply-runbook.md step 3"

# Recording must be absent unless it was deliberately requested.
STORAGE="$(aws connect list-instance-storage-configs --region "$REGION" \
  --instance-id "$INSTANCE_ID" --resource-type CALL_RECORDINGS \
  --query "StorageConfigs[].S3Config.BucketName" --output text 2>/dev/null || true)"
if [ "$EXPECT_RECORDING" = "false" ]; then
  case "$STORAGE" in
    *stockguard*) fail "a StockGuard recording bucket is attached although recording was not requested" ;;
    "") pass "no CALL_RECORDINGS configuration on the instance" ;;
    *) pass "CALL_RECORDINGS config exists but is not StockGuard's; this apply did not create it" ;;
  esac
else
  case "$STORAGE" in
    *stockguard*) pass "StockGuard recording bucket is attached as requested" ;;
    *) fail "recording was requested but no StockGuard bucket is attached" ;;
  esac
fi

# The association is manual, but by the time this script runs it must exist:
# the contact flow cannot have been created without it.
LEX_ASSOC="$(aws connect list-bots --region "$REGION" --instance-id "$INSTANCE_ID" \
  --lex-version V2 --query "LexBots[].LexV2Bot.AliasArn" --output text 2>/dev/null || true)"
case "$LEX_ASSOC" in
  *"$ALIAS_ID"*) info "the qualification alias IS associated with Connect" ;;
  *) fail "the qualification alias is NOT associated with Connect - run the manual association command from the runbook BEFORE creating the flow" ;;
esac

echo
if [ "$MANUAL_CHECKS" -gt 0 ]; then
  echo "${MANUAL_CHECKS} item(s) marked MANUAL are NOT verified by this script and still need a human."
fi
if [ "$FAILURES" -eq 0 ]; then
  echo "Automated checks passed. No AWS resource was modified, no call was placed."
  exit 0
fi
echo "Verification found ${FAILURES} problem(s). No AWS resource was modified, no call was placed."
exit 1
