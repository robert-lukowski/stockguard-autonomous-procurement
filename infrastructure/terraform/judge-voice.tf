# ---------------------------------------------------------------------------
# WebRTC Judge Mode: the judge speaks, StockGuard answers.
#
# The whole stack is created only when var.webrtc_judge_mode_enabled is true,
# which defaults to false. It additionally requires the procurement table (the
# orchestrator has nowhere to persist a run without it) and an OIDC issuer for
# the session endpoint's JWT authorizer.
#
# That last condition is structural, not advisory: `local.judge_voice_enabled`
# is false whenever the issuer or audience is unset, so THERE IS NO WAY TO
# CREATE THIS API WITHOUT AN AUTHORIZER. The one endpoint that can start a
# billable Amazon Connect contact cannot exist unauthenticated.
# ---------------------------------------------------------------------------
locals {
  judge_voice_enabled = (
    var.webrtc_judge_mode_enabled &&
    var.procurement_table_enabled &&
    length(trimspace(var.judge_auth_issuer)) > 0 &&
    length(trimspace(var.judge_auth_audience)) > 0
  )
  judge_voice_count       = local.judge_voice_enabled ? 1 : 0
  judge_lex_alias_name    = "judge"
  judge_lex_locale_id     = "en_US"
  judge_voice_flow_name   = "${local.name_prefix}-judge-voice"
  judge_voice_table_name  = var.procurement_table_name
  judge_lex_bot_alias_arn = local.judge_voice_enabled ? "arn:aws:lex:${var.aws_region}:${var.aws_account_id}:bot-alias/${aws_lexv2models_bot.judge_voice[0].id}/${awscc_lex_bot_alias.judge_voice[0].bot_alias_id}" : ""
}

# ---------------------------------------------------------------------------
# Lex V2: the judge-facing conversation.
#
# Deliberately three intents plus the built-in fallback. The procurement
# request itself is NOT slot-filled: `interpretUtterance` already extracts
# product, quantity and delivery window deterministically from the transcript,
# and it is covered by tests. Slot elicitation here would duplicate that logic
# in a place no test can reach, and would make the judge answer three questions
# instead of speaking one sentence.
# ---------------------------------------------------------------------------
resource "aws_lexv2models_bot" "judge_voice" {
  count = local.judge_voice_count

  name     = "${local.name_prefix}-judge-voice"
  role_arn = aws_iam_role.judge_lex_bot[0].arn

  # Synthetic demo data only: no real customer speech is processed.
  data_privacy {
    child_directed = false
  }

  idle_session_ttl_in_seconds = 300
}

resource "aws_iam_role" "judge_lex_bot" {
  count = local.judge_voice_count

  name = "${local.name_prefix}-judge-lex-bot"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lexv2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "judge_lex_bot" {
  count = local.judge_voice_count

  name = "polly-synthesis"
  role = aws_iam_role.judge_lex_bot[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["polly:SynthesizeSpeech"]
      Resource = "*"
    }]
  })
}

resource "aws_lexv2models_bot_locale" "judge_voice" {
  count = local.judge_voice_count

  bot_id      = aws_lexv2models_bot.judge_voice[0].id
  bot_version = "DRAFT"
  locale_id   = local.judge_lex_locale_id

  # Low enough that a naturally-phrased procurement sentence matches, high
  # enough that "yes" does not land on RequestProcurement.
  n_lu_intent_confidence_threshold = 0.40

  voice_settings {
    voice_id = "Joanna"
    engine   = "neural"
  }
}

resource "aws_lexv2models_intent" "request_procurement" {
  count = local.judge_voice_count

  bot_id      = aws_lexv2models_bot.judge_voice[0].id
  bot_version = aws_lexv2models_bot_locale.judge_voice[0].bot_version
  locale_id   = aws_lexv2models_bot_locale.judge_voice[0].locale_id
  name        = "RequestProcurement"
  description = "Any spoken procurement request. The transcript is parsed deterministically by the Lambda."

  sample_utterances { utterance = "I need twenty industrial SSD drives within a week" }
  sample_utterances { utterance = "I need some industrial SSDs" }
  sample_utterances { utterance = "We need network adapters within ten days" }
  sample_utterances { utterance = "Can you order forty SSD drives" }
  sample_utterances { utterance = "I want to buy memory modules" }
  sample_utterances { utterance = "Order four rack UPS units" }
  sample_utterances { utterance = "I need to purchase some hardware" }
  sample_utterances { utterance = "Check availability and pricing" }

  fulfillment_code_hook {
    enabled = true
  }
}

resource "aws_lexv2models_intent" "confirm_purchase" {
  count = local.judge_voice_count

  bot_id      = aws_lexv2models_bot.judge_voice[0].id
  bot_version = aws_lexv2models_bot_locale.judge_voice[0].bot_version
  locale_id   = aws_lexv2models_bot_locale.judge_voice[0].locale_id
  name        = "ConfirmPurchase"
  description = "Explicit acceptance. The confirmation token never leaves the server."

  sample_utterances { utterance = "yes" }
  sample_utterances { utterance = "yes please create it" }
  sample_utterances { utterance = "go ahead" }
  sample_utterances { utterance = "create the purchase request" }
  sample_utterances { utterance = "confirm" }
  sample_utterances { utterance = "that works" }

  fulfillment_code_hook {
    enabled = true
  }
}

resource "aws_lexv2models_intent" "decline_purchase" {
  count = local.judge_voice_count

  bot_id      = aws_lexv2models_bot.judge_voice[0].id
  bot_version = aws_lexv2models_bot_locale.judge_voice[0].bot_version
  locale_id   = aws_lexv2models_bot_locale.judge_voice[0].locale_id
  name        = "DeclinePurchase"
  description = "Explicit rejection. Recorded as its own outcome, never as an absence of one."

  sample_utterances { utterance = "no" }
  sample_utterances { utterance = "no thanks" }
  sample_utterances { utterance = "cancel that" }
  sample_utterances { utterance = "do not order it" }
  sample_utterances { utterance = "stop" }

  fulfillment_code_hook {
    enabled = true
  }
}

resource "aws_lexv2models_bot_version" "judge_voice" {
  count = local.judge_voice_count

  bot_id = aws_lexv2models_bot.judge_voice[0].id

  locale_specification = {
    (local.judge_lex_locale_id) = {
      source_bot_version = "DRAFT"
    }
  }

  depends_on = [
    aws_lexv2models_intent.request_procurement,
    aws_lexv2models_intent.confirm_purchase,
    aws_lexv2models_intent.decline_purchase,
  ]
}

# Cloud Control: hashicorp/aws still has no aws_lexv2models_bot_alias
# (hashicorp/terraform-provider-aws#35780).
resource "awscc_lex_bot_alias" "judge_voice" {
  count = local.judge_voice_count

  bot_id         = aws_lexv2models_bot.judge_voice[0].id
  bot_alias_name = local.judge_lex_alias_name
  bot_version    = aws_lexv2models_bot_version.judge_voice[0].bot_version

  bot_alias_locale_settings = [{
    locale_id = local.judge_lex_locale_id
    bot_alias_locale_setting = {
      enabled = true
      code_hook_specification = {
        lambda_code_hook = {
          lambda_arn                  = aws_lambda_function.judge_voice[0].arn
          code_hook_interface_version = "1.0"
        }
      }
    }
  }]
}

# ---------------------------------------------------------------------------
# Lex fulfilment Lambda: the bridge from speech to the procurement core.
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "judge_voice" {
  count = local.judge_voice_count

  name              = "/aws/lambda/${local.name_prefix}-judge-voice"
  retention_in_days = var.log_retention_days
}

data "archive_file" "judge_voice" {
  count = local.judge_voice_count

  type        = "zip"
  source_dir  = "${path.module}/build/judgeVoice"
  output_path = "${path.module}/build/judgeVoice.zip"
}

resource "aws_iam_role" "judge_voice" {
  count = local.judge_voice_count

  name = "${local.name_prefix}-judge-voice"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "judge_voice" {
  count = local.judge_voice_count

  name = "${local.name_prefix}-judge-voice-runtime"
  role = aws_iam_role.judge_voice[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteFunctionLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.judge_voice[0].arn}:*"
      },
      {
        Sid    = "ReadWriteProcurementSessions"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ]
        Resource = aws_dynamodb_table.procurement[0].arn
      },
    ]
  })
}

resource "aws_lambda_function" "judge_voice" {
  count = local.judge_voice_count

  function_name = "${local.name_prefix}-judge-voice"
  description   = "Lex fulfilment: judge speech to the controlled procurement tools."
  role          = aws_iam_role.judge_voice[0].arn

  filename         = data.archive_file.judge_voice[0].output_path
  source_code_hash = data.archive_file.judge_voice[0].output_base64sha256
  handler          = "index.lexFulfillment"
  runtime          = "nodejs22.x"

  # Lex allows 30s for a code hook. Staying under it means a slow turn surfaces
  # as our own fail-closed message rather than a Lex timeout the judge hears as
  # silence.
  timeout     = 20
  memory_size = 512

  environment {
    variables = {
      VOICE_FULFILMENT_ENABLED = "true"
      PROCUREMENT_TABLE        = local.judge_voice_table_name
      ALLOWED_LEX_BOT_IDS      = aws_lexv2models_bot.judge_voice[0].id
      # Alias NAME, not id: the alias's code hook points at this function, so
      # referencing the generated id here would be a Terraform cycle.
      ALLOWED_LEX_ALIAS_NAMES = local.judge_lex_alias_name
      ALLOWED_LEX_LOCALES     = local.judge_lex_locale_id
    }
  }

  depends_on = [aws_cloudwatch_log_group.judge_voice]
}

resource "aws_lambda_permission" "judge_lex_invoke" {
  count = local.judge_voice_count

  statement_id  = "AllowJudgeLexV2Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.judge_voice[0].function_name
  principal     = "lexv2.amazonaws.com"
  source_arn    = local.judge_lex_bot_alias_arn
}

# ---------------------------------------------------------------------------
# The Connect contact flow the WebRTC judge lands in.
#
# Four actions, and no more: logging, a greeting that finishes before Lex
# listens, the Lex turn, and disconnect. The greeting is a separate
# MessageParticipant for the reason connect.tf records - playing text while Lex
# gathers input permits barge-in and messy turn-taking.
#
# Unlike the supplier flow there is no bounded retry: a human judge who is not
# understood simply says it again, and Lex keeps the turn open because our
# fulfilment returns ElicitIntent.
# ---------------------------------------------------------------------------
resource "aws_connect_contact_flow" "judge_voice" {
  count = local.judge_voice_count

  instance_id = var.connect_instance_id
  name        = local.judge_voice_flow_name
  description = "Answers a WebRTC judge and hands them to the StockGuard procurement assistant."
  type        = "CONTACT_FLOW"

  content = jsonencode({
    Version     = "2019-10-30"
    StartAction = "set-logging"

    Actions = [
      {
        Identifier  = "set-logging"
        Type        = "UpdateFlowLoggingBehavior"
        Parameters  = { FlowLoggingBehavior = "Enabled" }
        Transitions = { NextAction = "greeting" }
      },
      {
        Identifier = "greeting"
        Type       = "MessageParticipant"
        Parameters = {
          Text = "StockGuard procurement. What do you need?"
        }
        Transitions = {
          NextAction = "lex"
          Errors     = [{ ErrorType = "NoMatchingError", NextAction = "disconnect" }]
        }
      },
      {
        Identifier = "lex"
        Type       = "ConnectParticipantWithLexBot"
        Parameters = {
          LexV2Bot = { AliasArn = local.judge_lex_bot_alias_arn }
          # Keep StockGuard's spoken answer from being cut off mid-sentence.
          LexSessionAttributes = {
            "x-amz-lex:allow-interrupt:*:*" = "false"
          }
          Text = "Go ahead."
        }
        Transitions = {
          NextAction = "disconnect"
          Errors = [
            { ErrorType = "NoMatchingCondition", NextAction = "disconnect" },
            { ErrorType = "NoMatchingError", NextAction = "disconnect" },
          ]
        }
      },
      {
        Identifier  = "disconnect"
        Type        = "DisconnectParticipant"
        Parameters  = {}
        Transitions = {}
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# The protected session endpoint.
#
# HTTP API with a JWT authorizer. There is no unauthenticated route: the
# authorizer is attached to the only route, and local.judge_voice_enabled is
# false without an issuer and audience, so the API cannot be created without
# one.
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "voice_session" {
  count = local.judge_voice_count

  name              = "/aws/lambda/${local.name_prefix}-voice-session"
  retention_in_days = var.log_retention_days
}

data "archive_file" "voice_session" {
  count = local.judge_voice_count

  type        = "zip"
  source_dir  = "${path.module}/build/voiceSession"
  output_path = "${path.module}/build/voiceSession.zip"
}

resource "aws_iam_role" "voice_session" {
  count = local.judge_voice_count

  name = "${local.name_prefix}-voice-session"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "voice_session" {
  count = local.judge_voice_count

  name = "${local.name_prefix}-voice-session-runtime"
  role = aws_iam_role.voice_session[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteFunctionLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.voice_session[0].arn}:*"
      },
      {
        Sid    = "ReadWriteVoiceGrantsAndSessions"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ]
        Resource = aws_dynamodb_table.procurement[0].arn
      },
      {
        # Scoped to the one flow on the one instance. This grant is what makes
        # a billable contact possible, so it names both explicitly rather than
        # allowing StartWebRTCContact on the instance as a whole.
        Sid      = "StartJudgeWebRtcContact"
        Effect   = "Allow"
        Action   = ["connect:StartWebRTCContact"]
        Resource = "arn:aws:connect:${var.aws_region}:${var.aws_account_id}:instance/${var.connect_instance_id}/contact-flow/${aws_connect_contact_flow.judge_voice[0].contact_flow_id}"
      },
    ]
  })
}

resource "aws_lambda_function" "voice_session" {
  count = local.judge_voice_count

  function_name = "${local.name_prefix}-voice-session"
  description   = "Protected endpoint that starts one WebRTC voice session per procurement run."
  role          = aws_iam_role.voice_session[0].arn

  filename         = data.archive_file.voice_session[0].output_path
  source_code_hash = data.archive_file.voice_session[0].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"

  timeout     = 15
  memory_size = 256

  environment {
    variables = {
      WEBRTC_ENABLED          = "true"
      PROCUREMENT_TABLE       = local.judge_voice_table_name
      CONNECT_INSTANCE_ID     = var.connect_instance_id
      CONNECT_WEBRTC_FLOW_ID  = aws_connect_contact_flow.judge_voice[0].contact_flow_id
      ALLOWED_ORIGIN          = var.judge_portal_origin
      VOICE_SESSIONS_PER_HOUR = tostring(var.voice_sessions_per_judge_per_hour)
    }
  }

  depends_on = [aws_cloudwatch_log_group.voice_session]
}

resource "aws_apigatewayv2_api" "voice_session" {
  count = local.judge_voice_count

  name          = "${local.name_prefix}-voice-session"
  protocol_type = "HTTP"

  cors_configuration {
    allow_credentials = true
    allow_headers     = ["content-type", "authorization"]
    allow_methods     = ["POST", "OPTIONS"]
    allow_origins     = [var.judge_portal_origin]
    max_age           = 300
  }
}

resource "aws_apigatewayv2_authorizer" "voice_session" {
  count = local.judge_voice_count

  api_id           = aws_apigatewayv2_api.voice_session[0].id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${local.name_prefix}-judge-jwt"

  jwt_configuration {
    audience = [var.judge_auth_audience]
    issuer   = var.judge_auth_issuer
  }
}

resource "aws_apigatewayv2_integration" "voice_session" {
  count = local.judge_voice_count

  api_id                 = aws_apigatewayv2_api.voice_session[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.voice_session[0].invoke_arn
  payload_format_version = "2.0"
}

# The ONLY route, and it carries the authorizer. There is deliberately no
# catch-all $default route: an unauthenticated path to this Lambda must not
# exist even by omission.
resource "aws_apigatewayv2_route" "voice_session" {
  count = local.judge_voice_count

  api_id             = aws_apigatewayv2_api.voice_session[0].id
  route_key          = "POST /voice-sessions"
  target             = "integrations/${aws_apigatewayv2_integration.voice_session[0].id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.voice_session[0].id
}

resource "aws_apigatewayv2_stage" "voice_session" {
  count = local.judge_voice_count

  api_id      = aws_apigatewayv2_api.voice_session[0].id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    # A ceiling on how fast contacts can be requested, independent of the
    # per-judge limit the Lambda enforces in DynamoDB. Two different failure
    # modes, two different controls.
    throttling_burst_limit = 5
    throttling_rate_limit  = 2
  }
}

resource "aws_lambda_permission" "voice_session_api" {
  count = local.judge_voice_count

  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.voice_session[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.voice_session[0].execution_arn}/*/*"
}

output "voice_session_endpoint" {
  value       = one(aws_apigatewayv2_stage.voice_session[*].invoke_url)
  description = "Null unless WebRTC Judge Mode is enabled. Set VITE_WEBRTC_SESSION_URL to this plus /voice-sessions."
}

output "judge_voice_flow_id" {
  value       = one(aws_connect_contact_flow.judge_voice[*].contact_flow_id)
  description = "Contact flow a WebRTC judge is routed into."
}

output "judge_lex_bot_alias_arn" {
  value       = local.judge_voice_enabled ? local.judge_lex_bot_alias_arn : null
  description = "Alias ARN required by the manual Connect association step."
}

output "judge_manual_connect_association_command" {
  description = <<-EOT
    Terraform gap: aws_connect_bot_association is Lex V1 only
    (hashicorp/terraform-provider-aws#30869). Run this once, manually, BEFORE
    the apply that creates the judge contact flow - Connect validates the flow
    against the association at creation time.
  EOT

  value = local.judge_voice_enabled ? join(" ", [
    "aws connect associate-bot",
    "--region ${var.aws_region}",
    "--instance-id ${var.connect_instance_id}",
    "--lex-v2-bot AliasArn=${local.judge_lex_bot_alias_arn}",
  ]) : null
}
