output "lex_bot_id" {
  value       = aws_lexv2models_bot.supplier_simulator.id
  description = "Lex V2 bot id."
}

output "lex_bot_alias_id" {
  value       = awscc_lex_bot_alias.supplier_simulator.bot_alias_id
  description = "Runtime alias id used by the contact flow."
}

output "lex_bot_alias_arn" {
  value       = "arn:aws:lex:${var.aws_region}:${var.aws_account_id}:bot-alias/${aws_lexv2models_bot.supplier_simulator.id}/${awscc_lex_bot_alias.supplier_simulator.bot_alias_id}"
  description = "Alias ARN required by the manual Connect association step."
}

output "contact_flow_id" {
  value       = aws_connect_contact_flow.supplier_simulator.contact_flow_id
  description = "Contact flow to which the existing +1 number is assigned MANUALLY, during an approved deployment only."
}

output "supplier_simulator_function_name" {
  value       = aws_lambda_function.supplier_simulator.function_name
  description = "Synthetic supplier Lambda."
}

output "simulator_enabled" {
  value       = var.simulator_enabled
  description = "False means the supplier will refuse every turn, whatever else is deployed."
}

output "manual_connect_association_command" {
  description = <<-EOT
    Terraform gap: aws_connect_bot_association is Lex V1 only
    (hashicorp/terraform-provider-aws#30869). Run this once, manually, during
    the approved deployment. It is idempotent.
  EOT

  value = join(" ", [
    "aws connect associate-bot",
    "--region ${var.aws_region}",
    "--instance-id ${var.connect_instance_id}",
    "--lex-v2-bot AliasArn=arn:aws:lex:${var.aws_region}:${var.aws_account_id}:bot-alias/${aws_lexv2models_bot.supplier_simulator.id}/${awscc_lex_bot_alias.supplier_simulator.bot_alias_id}",
  ])
}
