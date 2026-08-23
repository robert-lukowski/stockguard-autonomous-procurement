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

  # The account cannot support a positive reserved-concurrency allocation while
  # preserving AWS's required unreserved pool. Keep the disabled simulator at
  # zero concurrency, then deliberately remove that reservation only while the
  # qualification toggle is armed. SIMULATOR_ENABLED remains the second,
  # independent fail-closed guard inside the handler.
  reserved_concurrent_executions = var.simulator_enabled ? -1 : 0

  environment {
    variables = {
      SIMULATOR_ENABLED   = tostring(var.simulator_enabled)
      ALLOWED_LEX_BOT_IDS = aws_lexv2models_bot.supplier_simulator.id
      # Deliberately the alias NAME, not its generated id: the alias's code
      # hook points at this function, so referencing the id here would create
      # a Lambda <-> alias dependency cycle.
      ALLOWED_LEX_ALIAS_NAMES   = local.lex_alias_name
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
  source_arn    = local.lex_bot_alias_arn
}
