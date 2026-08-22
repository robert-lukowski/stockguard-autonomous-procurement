# ---------------------------------------------------------------------------
# Lambda execution role.
#
# Architecture A needs CloudWatch Logs and nothing else. The handler makes no
# AWS API calls at all - verified by the bundle containing zero external
# require() calls - so any additional permission here would be unjustified.
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
