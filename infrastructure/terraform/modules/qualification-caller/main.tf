variable "name_prefix" {
  type = string
}

variable "log_retention_days" {
  type = number
}

variable "qualification_sku" {
  type = string
}

variable "qualification_quantity" {
  type = number
}

variable "qualification_required_by" {
  type = string
}

locals {
  function_name = "${var.name_prefix}-caller"
  pages_origin  = "https://robert-lukowski.github.io"
  secret_name   = "stockguard/calle/api-key"
}

# The secret is created manually. Terraform reads only its metadata/ARN; the
# secret value never enters configuration or state.
data "aws_secretsmanager_secret" "calle" {
  name = local.secret_name
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "this" {
  name = local.function_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy" "this" {
  name = "${local.function_name}-runtime"
  role = aws_iam_role.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WriteFunctionLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.this.arn}:*"
      },
      {
        Sid      = "ReadCallERuntimeSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = data.aws_secretsmanager_secret.calle.arn
      }
    ]
  })
}

data "archive_file" "this" {
  type        = "zip"
  source_dir  = "${path.root}/build/liveCaller"
  output_path = "${path.root}/build/liveCaller.zip"
}

resource "aws_lambda_function" "this" {
  function_name = local.function_name
  description   = "PIN-gated live CALL-E qualification backend for the StockGuard judge demo."
  role          = aws_iam_role.this.arn

  filename         = data.archive_file.this.output_path
  source_code_hash = data.archive_file.this.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"

  # The synchronous path waits for the real CALL-E conversation to complete.
  # The workflow's own polling ceiling is five minutes, so leave a small margin.
  timeout     = 360
  memory_size = 256

  # One live qualification may be in flight at a time.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      CALLE_SECRET_ID           = data.aws_secretsmanager_secret.calle.arn
      QUALIFICATION_SKU         = var.qualification_sku
      QUALIFICATION_QUANTITY    = tostring(var.qualification_quantity)
      QUALIFICATION_REQUIRED_BY = var.qualification_required_by
    }
  }

  depends_on = [aws_cloudwatch_log_group.this]
}

# Public HTTPS is required because GitHub Pages cannot hold AWS credentials.
# The request is still gated inside the Lambda by the server-side Judge PIN,
# and the request cannot choose a destination, supplier, SKU or quantity.
#
# With hashicorp/aws 6.x, authorization_type=NONE also installs the two Lambda
# resource-policy permissions now required for Function URL invocation.
resource "aws_lambda_function_url" "this" {
  function_name      = aws_lambda_function.this.function_name
  authorization_type = "NONE"

  cors {
    allow_credentials = false
    allow_headers     = ["content-type", "x-confirm", "x-judge-pin"]
    allow_methods     = ["POST"]
    allow_origins     = [local.pages_origin]
    max_age           = 300
  }
}

output "url" {
  value       = aws_lambda_function_url.this.function_url
  description = "Public Function URL used by the PIN-gated GitHub Pages live demo."
}
