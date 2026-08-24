module "qualification_caller" {
  source = "./modules/qualification-caller"

  name_prefix               = local.name_prefix
  log_retention_days        = var.log_retention_days
  qualification_sku         = var.qualification_sku
  qualification_quantity    = var.qualification_quantity
  qualification_required_by = var.qualification_required_by
}

output "qualification_caller_url" {
  value       = module.qualification_caller.url
  description = "Set this as the GitHub repository variable QUALIFICATION_BACKEND_URL for the Pages build."
}
