# ---------------------------------------------------------------------------
# Lambda execution role.
#
# Supplier facts remain deterministic. The Lambda may write its own logs and
# invoke exactly one foundation model to realize those facts as natural spoken
# English. Bedrock cannot change the quote object, and the deterministic text
# remains the fallback when realization fails.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "supplier_simulator" {
  name               = "${local.name_prefix}-supplier-simulator"
  description        = "Execution role for the deterministic synthetic supplier Lambda."
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "supplier_simulator_logs" {
  statement {
    sid    = "WriteOwnLogStreams"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    # Scoped to this function's log group only.
    resources = ["${aws_cloudwatch_log_group.supplier_simulator.arn}:*"]
  }
}

resource "aws_iam_role_policy" "supplier_simulator_logs" {
  name   = "cloudwatch-logs"
  role   = aws_iam_role.supplier_simulator.id
  policy = data.aws_iam_policy_document.supplier_simulator_logs.json
}

data "aws_iam_policy_document" "supplier_simulator_bedrock" {
  statement {
    sid       = "RealizeDeterministicSupplierResponse"
    effect    = "Allow"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:eu-central-1::foundation-model/amazon.nova-micro-v1:0"]
  }
}

resource "aws_iam_role_policy" "supplier_simulator_bedrock" {
  name   = "bedrock-supplier-response"
  role   = aws_iam_role.supplier_simulator.id
  policy = data.aws_iam_policy_document.supplier_simulator_bedrock.json
}
