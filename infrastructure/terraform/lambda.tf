# The log group is created explicitly rather than implicitly by first
# invocation, so retention is bounded from the very first call.
resource "aws_cloudwatch_log_group" "supplier_simulator" {
  name              = "/aws/lambda/${local.name_prefix}-supplier-simulator"
  retention_in_days = var.log_retention_days
}

data "archive_file" "supplier_simulator" {
  type        = "zip"
  source_dir  = "${path.module}/build/supplierSimulator"
  output_path = "${path.module}/build/supplierSimulator.zip"
}

resource "aws_lambda_function" "supplier_simulator" {
  function_name = "${local.name_prefix}-supplier-simulator"
  description   = "Deterministic synthetic supplier for CALL-E qualification. No AWS SDK, no secrets, no outbound network."
  role          = aws_iam_role.supplier_simulator.arn

  filename         = data.archive_file.supplier_simulator.output_path
  source_code_hash = data.archive_file.supplier_simulator.output_base64sha256
  handler          = "index.lexFulfillment"
  runtime          = "nodejs22.x"

  timeout     = 10
  memory_size = 256

  # Bounded blast radius: a runaway loop cannot fan out.
  reserved_concurrent_executions = 2

  environment {
    variables = {
      SIMULATOR_ENABLED         = tostring(var.simulator_enabled)
      ALLOWED_LEX_BOT_IDS       = aws_lexv2models_bot.supplier_simulator.id
      ALLOWED_LEX_ALIAS_IDS     = awscc_lex_bot_alias.supplier_simulator.bot_alias_id
      ALLOWED_LEX_LOCALES       = local.lex_locale_id
      QUALIFICATION_SKU         = var.qualification_sku
      QUALIFICATION_QUANTITY    = tostring(var.qualification_quantity)
      QUALIFICATION_REQUIRED_BY = var.qualification_required_by
    }
  }

  depends_on = [aws_cloudwatch_log_group.supplier_simulator]
}

# Lex may invoke the function, narrowed to this bot alias specifically.
resource "aws_lambda_permission" "lex_invoke" {
  statement_id  = "AllowLexV2Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.supplier_simulator.function_name
  principal     = "lexv2.amazonaws.com"
  source_arn    = "arn:aws:lex:${var.aws_region}:${var.aws_account_id}:bot-alias/${aws_lexv2models_bot.supplier_simulator.id}/${awscc_lex_bot_alias.supplier_simulator.bot_alias_id}"
}
