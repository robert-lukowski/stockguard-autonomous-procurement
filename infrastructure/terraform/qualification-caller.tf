# ---------------------------------------------------------------------------
# PSTN live caller: OFF by default.
#
# This module is the only thing in the configuration that can place a real,
# paid telephone call, and it publishes a Lambda Function URL with
# authorization_type = "NONE" to do it. Since the Judge Portal pivot the MVP
# no longer needs it (see docs/adr-0001-webrtc-judge-portal.md), so it is now
# created only when var.live_caller_enabled is explicitly set to true.
#
# count = 0 means the Function URL is not in the plan at all - not merely
# unreferenced, but never created. Nothing in CI sets this variable.
# ---------------------------------------------------------------------------
module "qualification_caller" {
  count  = var.live_caller_enabled ? 1 : 0
  source = "./modules/qualification-caller"

  name_prefix               = local.name_prefix
  log_retention_days        = var.log_retention_days
  qualification_sku         = var.qualification_sku
  qualification_quantity    = var.qualification_quantity
  qualification_required_by = var.qualification_required_by
  recording_enabled         = var.enable_call_recording
  recording_bucket_name     = var.recording_bucket_name
  recording_bucket_arn      = local.recording_bucket_arn
  recording_prefix          = var.recording_prefix
  recording_kms_key_arn     = var.recording_kms_key_arn
  recording_url_ttl_seconds = local.recording_url_ttl_seconds
}

output "qualification_caller_url" {
  value       = one(module.qualification_caller[*].url)
  description = "Null unless var.live_caller_enabled is true. When set, this is a PUBLIC unauthenticated Function URL that places real paid PSTN calls."
}
