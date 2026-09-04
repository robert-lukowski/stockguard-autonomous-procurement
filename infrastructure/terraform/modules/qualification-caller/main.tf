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

variable "recording_enabled" {
  type = bool
}

variable "recording_bucket_name" {
  type = string
}

variable "recording_bucket_arn" {
  type = string
}

variable "recording_prefix" {
  type = string
}

variable "recording_kms_key_arn" {
  type = string
}

variable "recording_url_ttl_seconds" {
  type = number
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

resource "aws_iam_role_policy" "recordings" {
  count = var.recording_enabled ? 1 : 0
  name  = "${local.function_name}-recording-lookup"
  role  = aws_iam_role.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListRecentCallRecordings"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = var.recording_bucket_arn
        Condition = {
          StringLike = {
            "s3:prefix" = [
              "${var.recording_prefix}/*",
            ]
          }
        }
      },
      {
        Sid      = "ReadSelectedCallRecording"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${var.recording_bucket_arn}/${var.recording_prefix}/*"
      },
      {
        Sid      = "DecryptSelectedCallRecording"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.recording_kms_key_arn
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

  # Deliberately unreserved. This account must preserve Lambda's minimum
  # unreserved concurrency pool, and an earlier positive reservation was
  # rejected by AWS for exactly that reason. The Judge PIN and fixed destination
  # bound the public demo instead of a reservation that this account cannot use.

  environment {
    variables = {
      CALLE_SECRET_ID           = data.aws_secretsmanager_secret.calle.arn
      QUALIFICATION_SKU         = var.qualification_sku
      QUALIFICATION_QUANTITY    = tostring(var.qualification_quantity)
      QUALIFICATION_REQUIRED_BY = var.qualification_required_by
      RECORDING_ENABLED         = tostring(var.recording_enabled)
      RECORDING_BUCKET          = var.recording_bucket_name
      RECORDING_PREFIX          = var.recording_prefix
      RECORDING_URL_TTL_SECONDS = tostring(var.recording_url_ttl_seconds)
    }
  }

  depends_on = [aws_cloudwatch_log_group.this]
}

# PUBLIC, UNAUTHENTICATED ENDPOINT THAT SPENDS MONEY.
#
# authorization_type = "NONE" means AWS performs no authorization at all: any
# request on the internet reaches the Lambda, and an accepted POST places a
# real, paid outbound telephone call. Public HTTPS is required because GitHub
# Pages cannot hold AWS credentials, so the whole boundary is inside the
# function.
#
# What that boundary actually is:
#   - a server-side Judge PIN, compared with timingSafeEqual;
#   - a required x-confirm: PLACE-CALL header;
#   - a destination, supplier profile, SKU, quantity and deadline the request
#     cannot choose.
#
# What it is NOT, and must not be described as:
#   - a rate limit. There is none. Nothing throttles a caller who knows the PIN.
#   - a concurrency cap. The reservation above is deliberately absent.
#   - a durable call budget. CallEApiAdapter.startedCallsByWorkflow is a Map in
#     one container's memory; it does not survive a cold start and is not shared
#     across concurrent invocations, so it bounds a single warm container only.
#
# This whole module is created only when var.live_caller_enabled is true, which
# defaults to false. Before enabling it, add a durable cross-invocation spend
# control - the DynamoDB conditional-write pattern in
# src/server/judge/aws/dynamo.ts is the one already proven in this repository.
#
# With hashicorp/aws 6.x, authorization_type=NONE also installs the two Lambda
# resource-policy permissions now required for Function URL invocation.
resource "aws_lambda_function_url" "this" {
  function_name      = aws_lambda_function.this.function_name
  authorization_type = "NONE"

  cors {
    allow_credentials = false
    allow_headers     = ["content-type", "x-confirm", "x-judge-pin"]
    allow_methods     = ["GET", "POST"]
    allow_origins     = [local.pages_origin]
    max_age           = 300
  }
}

output "url" {
  value       = aws_lambda_function_url.this.function_url
  description = "Public Function URL used by the PIN-gated GitHub Pages live demo."
}
