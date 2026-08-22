locals {
  name_prefix = "stockguard-${var.environment}"

  connect_instance_arn = "arn:aws:connect:${var.aws_region}:${var.aws_account_id}:instance/${var.connect_instance_id}"

  # Architecture A is English only. DE and FR locales are added later as extra
  # aws_lexv2models_bot_locale resources on this same bot, which is why the
  # first qualification does not constrain the final design.
  lex_locale_id = "en_US"
}

data "aws_caller_identity" "current" {}

# Guard against pointing this configuration at the wrong account.
resource "terraform_data" "account_guard" {
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.aws_account_id
      error_message = "Credentials belong to a different AWS account than aws_account_id."
    }
  }
}
