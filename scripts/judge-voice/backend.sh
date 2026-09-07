#!/usr/bin/env bash
#
# The one place `terraform init` is configured for the judge-voice scripts.
#
# versions.tf declares `backend "s3" {}` as a PARTIAL configuration on purpose:
# the bucket, key and region are supplied at init time so no account identifier
# is committed. That means a bare `terraform init` has nowhere to get them.
#
#   - With -input=false it fails outright.
#   - Without -reconfigure it silently reuses whatever a stale .terraform/
#     directory was pointed at, which is worse: the script then plans against
#     a different state than CI manages, and says nothing.
#
# So every init goes through here, with the same four settings the CI workflow
# passes in .github/workflows/terraform-plan.yml. If the two ever drift, the
# scripts and CI are planning against different state.
#
# SOURCED, not executed. Callers use:
#   . "$SCRIPT_DIR/backend.sh"
#   tf_init_with_backend "$STATE_BUCKET" "$STATE_KEY" "$REGION"

# The key CI uses. A different key is a different state file, so this is a
# constant rather than something to guess at.
readonly TF_STATE_KEY_DEFAULT="runtime/terraform.tfstate"

# Runs terraform init against the shared remote state.
#
# Fails fast and by name on anything missing: an init that half-works leaves a
# .terraform/ behind that the next run would silently trust.
tf_init_with_backend() {
  local bucket="${1:-}"
  local key="${2:-}"
  local region="${3:-}"

  if [ -z "$bucket" ]; then
    echo "REFUSING: no state bucket." >&2
    echo "backend \"s3\" {} is a partial configuration, so terraform init has" >&2
    echo "nowhere to get the bucket and would either fail or reuse a stale" >&2
    echo "local .terraform/ pointing at different state." >&2
    echo "Pass --state-bucket, or set TF_STATE_BUCKET." >&2
    return 1
  fi
  if [ -z "$key" ]; then
    echo "REFUSING: no state key (expected $TF_STATE_KEY_DEFAULT)." >&2
    return 1
  fi
  if [ -z "$region" ]; then
    echo "REFUSING: no region for the state bucket." >&2
    echo "Pass --region, or set AWS_REGION." >&2
    return 1
  fi

  echo "==> terraform init (state: s3://$bucket/$key in $region)"
  # -reconfigure so a stale .terraform/ from an earlier init cannot win.
  # encrypt and use_lockfile mirror the CI workflow; use_lockfile is native S3
  # conditional-write locking, so there is no DynamoDB lock table.
  terraform init -reconfigure -input=false \
    -backend-config="bucket=$bucket" \
    -backend-config="key=$key" \
    -backend-config="region=$region" \
    -backend-config="encrypt=true" \
    -backend-config="use_lockfile=true" >/dev/null
}
