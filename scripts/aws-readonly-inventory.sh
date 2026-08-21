#!/usr/bin/env bash
set -euo pipefail

: "${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${CONNECT_INSTANCE_ALIAS:?CONNECT_INSTANCE_ALIAS is required}"

if [[ ! "${AWS_ACCOUNT_ID}" =~ ^[0-9]{12}$ ]]; then
  echo "AWS_ACCOUNT_ID must contain exactly 12 digits" >&2
  exit 1
fi
if [[ ! "${AWS_REGION}" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$ ]]; then
  echo "AWS_REGION has an invalid format" >&2
  exit 1
fi
if [[ ! "${CONNECT_INSTANCE_ALIAS}" =~ ^[A-Za-z0-9_-]{1,45}$ ]]; then
  echo "CONNECT_INSTANCE_ALIAS has an invalid format" >&2
  exit 1
fi

CALLER_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if [[ "${CALLER_ACCOUNT}" != "${AWS_ACCOUNT_ID}" ]]; then
  echo "OIDC assumed an unexpected AWS account" >&2
  exit 1
fi

INSTANCES_JSON="$(aws connect list-instances --region "${AWS_REGION}" --output json)"
INSTANCE_COUNT="$(jq --arg alias "${CONNECT_INSTANCE_ALIAS}" '[.InstanceSummaryList[] | select(.InstanceAlias == $alias)] | length' <<<"${INSTANCES_JSON}")"
if [[ "${INSTANCE_COUNT}" != "1" ]]; then
  echo "Expected exactly one Connect instance with alias ${CONNECT_INSTANCE_ALIAS}; found ${INSTANCE_COUNT}" >&2
  exit 1
fi

INSTANCE_ID="$(jq -r --arg alias "${CONNECT_INSTANCE_ALIAS}" '.InstanceSummaryList[] | select(.InstanceAlias == $alias) | .Id' <<<"${INSTANCES_JSON}")"

INSTANCE_SUMMARY="$(jq -c --arg alias "${CONNECT_INSTANCE_ALIAS}" '
  .InstanceSummaryList[]
  | select(.InstanceAlias == $alias)
  | {
      alias: .InstanceAlias,
      status: .InstanceStatus,
      inboundCallsEnabled: .InboundCallsEnabled,
      outboundCallsEnabled: .OutboundCallsEnabled
    }
' <<<"${INSTANCES_JSON}")"

FLOWS_JSON="$(aws connect list-contact-flows \
  --instance-id "${INSTANCE_ID}" \
  --region "${AWS_REGION}" \
  --output json)"
FLOW_SUMMARY="$(jq -c '
  {
    total: (.ContactFlowSummaryList | length),
    byType: (
      [.ContactFlowSummaryList[].ContactFlowType]
      | group_by(.)
      | map({key: .[0], value: length})
      | from_entries
    ),
    stockGuardFlows: [
      .ContactFlowSummaryList[]
      | select(.Name | ascii_downcase | contains("stockguard"))
      | {name: .Name, type: .ContactFlowType, state: .ContactFlowState, status: .ContactFlowStatus}
    ]
  }
' <<<"${FLOWS_JSON}")"

LAMBDA_JSON="$(aws connect list-lambda-functions \
  --instance-id "${INSTANCE_ID}" \
  --region "${AWS_REGION}" \
  --output json)"
LAMBDA_SUMMARY="$(jq -c '{associatedFunctionCount: (.LambdaFunctions | length)}' <<<"${LAMBDA_JSON}")"

BOTS_JSON="$(aws connect list-bots \
  --instance-id "${INSTANCE_ID}" \
  --lex-version V2 \
  --region "${AWS_REGION}" \
  --output json)"
BOT_SUMMARY="$(jq -c '{associatedLexV2BotCount: (.LexBots | length)}' <<<"${BOTS_JSON}")"

INTEGRATIONS_JSON="$(aws connect list-integration-associations \
  --instance-id "${INSTANCE_ID}" \
  --region "${AWS_REGION}" \
  --output json)"
INTEGRATION_SUMMARY="$(jq -c '
  {
    total: (.IntegrationAssociationSummaryList | length),
    byType: (
      [.IntegrationAssociationSummaryList[].IntegrationType]
      | group_by(.)
      | map({key: .[0], value: length})
      | from_entries
    )
  }
' <<<"${INTEGRATIONS_JSON}")"

SANITIZED_SUMMARY="$(jq -cn \
  --arg region "${AWS_REGION}" \
  --argjson instance "${INSTANCE_SUMMARY}" \
  --argjson contactFlows "${FLOW_SUMMARY}" \
  --argjson lambdaFunctions "${LAMBDA_SUMMARY}" \
  --argjson lexV2Bots "${BOT_SUMMARY}" \
  --argjson integrations "${INTEGRATION_SUMMARY}" \
  '{
    mode: "READ_ONLY",
    region: $region,
    instance: $instance,
    contactFlows: $contactFlows,
    lambdaFunctions: $lambdaFunctions,
    lexV2Bots: $lexV2Bots,
    integrations: $integrations,
    phoneNumbersInspected: false,
    resourcesChanged: false
  }')"

{
  echo "## StockGuard AWS read-only inventory"
  echo
  echo '```json'
  jq . <<<"${SANITIZED_SUMMARY}"
  echo '```'
  echo
  echo "No phone-number API, secret API or AWS write operation was invoked."
} >>"${GITHUB_STEP_SUMMARY}"

jq . <<<"${SANITIZED_SUMMARY}"
