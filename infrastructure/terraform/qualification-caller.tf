module "qualification_caller" {
  source = "./modules/qualification-caller"

  name_prefix               = local.name_prefix
  log_retention_days        = var.log_retention_days
  qualification_sku         = var.qualification_sku
  qualification_quantity    = var.qualification_quantity
  qualification_required_by = var.qualification_required_by
  recording_enabled         = var.enable_call_recording
  recording_bucket_name     = var.enable_call_recording ? aws_s3_bucket.recordings[0].id : ""
  recording_bucket_arn      = var.enable_call_recording ? aws_s3_bucket.recordings[0].arn : ""
  recording_prefix          = local.recording_prefix
  recording_url_ttl_seconds = local.recording_url_ttl_seconds
}

output "qualification_caller_url" {
  value       = module.qualification_caller.url
  description = "Set this as the GitHub repository variable QUALIFICATION_BACKEND_URL for the Pages build."
}
