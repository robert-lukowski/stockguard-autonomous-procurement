# ---------------------------------------------------------------------------
# WebRTC Judge Mode: the judge speaks, StockGuard answers.
#
# DEPLOYED IN TWO STAGES, because Amazon Connect validates a contact flow
# against its Lex bot association at creation time, and that association is a
# manual CLI step (aws_connect_bot_association is Lex V1 only,
# hashicorp/terraform-provider-aws#30869). Terraform cannot sequence a manual
# step, so a single apply races it and fails with InvalidContactFlowException.
#
#   Stage A  webrtc_judge_mode_enabled = true
#            DynamoDB, both auth Lambdas, the session Lambda, the HTTP API and
#            its Lambda authorizer, the Lex bot, locale, version and alias.
#            NO Connect flow.
#
#   bridge   build the Lex locale, wait for Built, associate the alias with the
#            Connect instance, verify. See docs/webrtc-first-voice-runbook.md.
#
#   Stage B  connect_judge_flow_enabled = true
#            The Connect judge flow, and StartWebRTCContact scoped to it.
#
# Authentication is the repository's own Judge Mode security, not an external
# identity provider: a judge types the access code printed on the submission,
# the login Lambda verifies it against a PBKDF2 digest in Secrets Manager, and
# issues a short-lived opaque token. The API's Lambda authorizer resolves that
# token to a server-minted judgeId. There is no route without the authorizer,
# so the endpoint that starts a billable contact cannot exist unauthenticated.
# ---------------------------------------------------------------------------
locals {
  # Stage A. Everything that does not touch Amazon Connect.
  judge_voice_enabled = var.webrtc_judge_mode_enabled && var.procurement_table_enabled
  judge_voice_count   = local.judge_voice_enabled ? 1 : 0

  # Stage B. Additionally requires the manual Lex association to have happened.
  judge_flow_enabled = local.judge_voice_enabled && var.connect_judge_flow_enabled
  judge_flow_count   = local.judge_flow_enabled ? 1 : 0

  judge_lex_alias_name    = "judge"
  judge_lex_locale_id     = "en_US"
  judge_voice_flow_name   = "${local.name_prefix}-judge-voice"
  judge_voice_table_name  = var.procurement_table_name
  judge_lex_bot_alias_arn = local.judge_voice_enabled ? "arn:aws:lex:${var.aws_region}:${var.aws_account_id}:bot-alias/${aws_lexv2models_bot.judge_voice[0].id}/${awscc_lex_bot_alias.judge_voice[0].bot_alias_id}" : ""

  # Empty in Stage A, so AwsConnectWebRtcContactPort reports itself disabled
  # and the service refuses rather than failing mid-call.
  judge_voice_flow_id = local.judge_flow_enabled ? aws_connect_contact_flow.judge_voice[0].contact_flow_id : ""
}

# The access-code digest is created manually. Terraform reads only its ARN.
data "aws_secretsmanager_secret" "judge_access_code" {
  count = local.judge_voice_count

  name = var.judge_access_code_secret_name
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

  name        = "${local.name_prefix}-judge-voice"
  description = "Judge-facing procurement assistant for WebRTC Judge Mode."
  role_arn    = aws_iam_role.judge_lex_bot[0].arn
  type        = "Bot"

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

  sample_utterance { utterance = "I need twenty industrial SSD drives within a week" }
  sample_utterance { utterance = "I need some industrial SSDs" }
  sample_utterance { utterance = "We need network adapters within ten days" }
  sample_utterance { utterance = "Can you order forty SSD drives" }
  sample_utterance { utterance = "I want to buy memory modules" }
  sample_utterance { utterance = "Order four rack UPS units" }
  sample_utterance { utterance = "I need to purchase some hardware" }
  sample_utterance { utterance = "Check availability and pricing" }

  fulfillment_code_hook {
    enabled = true
  }

  # BuildBotLocale materialises the service defaults for these two settings and
  # Terraform would then plan to strip them, a diff that never converges. Same
  # reasoning as the supplier intents in lex.tf.
  lifecycle {
    ignore_changes = [
      initial_response_setting,
      fulfillment_code_hook[0].post_fulfillment_status_specification,
    ]
  }
}

resource "aws_lexv2models_intent" "confirm_purchase" {
  count = local.judge_voice_count

  bot_id      = aws_lexv2models_bot.judge_voice[0].id
  bot_version = aws_lexv2models_bot_locale.judge_voice[0].bot_version
  locale_id   = aws_lexv2models_bot_locale.judge_voice[0].locale_id
  name        = "ConfirmPurchase"
  description = "Explicit acceptance. The confirmation token never leaves the server."

  sample_utterance { utterance = "yes" }
  sample_utterance { utterance = "yes please create it" }
  sample_utterance { utterance = "go ahead" }
  sample_utterance { utterance = "create the purchase request" }
  sample_utterance { utterance = "confirm" }
  sample_utterance { utterance = "that works" }

  fulfillment_code_hook {
    enabled = true
  }

  # BuildBotLocale materialises the service defaults for these two settings and
  # Terraform would then plan to strip them, a diff that never converges. Same
  # reasoning as the supplier intents in lex.tf.
  lifecycle {
    ignore_changes = [
      initial_response_setting,
      fulfillment_code_hook[0].post_fulfillment_status_specification,
    ]
  }
}

resource "aws_lexv2models_intent" "decline_purchase" {
  count = local.judge_voice_count

  bot_id      = aws_lexv2models_bot.judge_voice[0].id
  bot_version = aws_lexv2models_bot_locale.judge_voice[0].bot_version
  locale_id   = aws_lexv2models_bot_locale.judge_voice[0].locale_id
  name        = "DeclinePurchase"
  description = "Explicit rejection. Recorded as its own outcome, never as an absence of one."

  sample_utterance { utterance = "no" }
  sample_utterance { utterance = "no thanks" }
  sample_utterance { utterance = "cancel that" }
  sample_utterance { utterance = "do not order it" }
  sample_utterance { utterance = "stop" }

  fulfillment_code_hook {
    enabled = true
  }

  # BuildBotLocale materialises the service defaults for these two settings and
  # Terraform would then plan to strip them, a diff that never converges. Same
  # reasoning as the supplier intents in lex.tf.
  lifecycle {
    ignore_changes = [
      initial_response_setting,
      fulfillment_code_hook[0].post_fulfillment_status_specification,
    ]
  }
}

# ---------------------------------------------------------------------------
# Build the DRAFT locale.
#
# PROVIDER GAP: hashicorp/aws cannot build a Lex V2 locale, so the build is
# sequenced through the AWS CLI, exactly as lex.tf already does for the
# supplier bot.
#
# This is deliberately NOT a manual step. A version must be cut from a BUILT
# draft, so leaving the build to an operator between stages would mean Stage A
# snapshots an unbuilt locale and the bot answers nothing. The one thing that
# genuinely cannot be automated is the Connect association, and that is the
# only thing the manual bridge still contains.
# ---------------------------------------------------------------------------
resource "terraform_data" "judge_locale_build" {
  count = local.judge_voice_count

  # Rebuild whenever the conversational surface changes, so a new intent cannot
  # quietly ship inside an unbuilt locale.
  triggers_replace = [
    "generation-1-judge-voice",
    aws_lexv2models_bot_locale.judge_voice[0].id,
    aws_lexv2models_intent.request_procurement[0].id,
    aws_lexv2models_intent.confirm_purchase[0].id,
    aws_lexv2models_intent.decline_purchase[0].id,
  ]

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      BOT=${aws_lexv2models_bot.judge_voice[0].id}

      aws lexv2-models build-bot-locale --region ${var.aws_region}         --bot-id "$BOT" --bot-version DRAFT --locale-id ${local.judge_lex_locale_id} >/dev/null
      for _ in $(seq 1 60); do
        STATUS="$(aws lexv2-models describe-bot-locale --region ${var.aws_region}           --bot-id "$BOT" --bot-version DRAFT --locale-id ${local.judge_lex_locale_id}           --query botLocaleStatus --output text)"
        case "$STATUS" in
          Built) echo "judge locale built"; exit 0 ;;
          Failed) echo "judge locale build FAILED" >&2; exit 1 ;;
        esac
        sleep 5
      done
      echo "timed out waiting for the judge locale build" >&2
      exit 1
    EOT
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

  # The snapshot must be taken from a BUILT draft, so the build is a hard
  # dependency and a rebuild forces a fresh version. create_before_destroy
  # keeps a version alive for the alias while the new one is cut.
  depends_on = [terraform_data.judge_locale_build]

  lifecycle {
    replace_triggered_by  = [terraform_data.judge_locale_build]
    create_before_destroy = true
  }
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
  # STAGE B. Requires the manual Lex association to already exist.
  count = local.judge_flow_count

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
    Statement = concat([
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
        Sid    = "ReadJudgeAccessCodeDigest"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        # The login Lambda needs it; the session Lambda shares this policy only
        # because both run the same auth composition. Read-only, one secret.
        Resource = data.aws_secretsmanager_secret.judge_access_code[0].arn
      },
      ],
      # STAGE B ONLY. Scoped to the one flow on the one instance: this grant is
      # what makes a billable contact possible, so it names both explicitly
      # rather than allowing StartWebRTCContact on the instance as a whole. In
      # Stage A it is absent entirely, so the Lambda physically cannot start a
      # contact even if something else were misconfigured.
      local.judge_flow_enabled ? [{
        Sid      = "StartJudgeWebRtcContact"
        Effect   = "Allow"
        Action   = ["connect:StartWebRTCContact"]
        Resource = "arn:aws:connect:${var.aws_region}:${var.aws_account_id}:instance/${var.connect_instance_id}/contact-flow/${aws_connect_contact_flow.judge_voice[0].contact_flow_id}"
      }] : [],
    )
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
      CONNECT_WEBRTC_FLOW_ID  = local.judge_voice_flow_id
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

# ---------------------------------------------------------------------------
# The Lambda authorizer.
#
# Resolves the opaque judge token to a server-minted judgeId and puts it in the
# request context. voiceSessionHandler reads authorizer.lambda.judgeId and
# nothing else, so this is the single place identity is decided.
#
# Caching is DISABLED. A cached authorization would keep a revoked or expired
# token working for the cache lifetime, and the whole point of a short-lived
# token is that it stops working promptly.
# ---------------------------------------------------------------------------
resource "aws_apigatewayv2_authorizer" "voice_session" {
  count = local.judge_voice_count

  api_id                            = aws_apigatewayv2_api.voice_session[0].id
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = aws_lambda_function.judge_authorizer[0].invoke_arn
  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true
  identity_sources                  = ["$request.header.Authorization"]
  authorizer_result_ttl_in_seconds  = 0
  name                              = "${local.name_prefix}-judge-token"
}

resource "aws_lambda_permission" "judge_authorizer_api" {
  count = local.judge_voice_count

  statement_id  = "AllowApiGatewayInvokeAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.judge_authorizer[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.voice_session[0].execution_arn}/*"
}

# ---------------------------------------------------------------------------
# Judge sign-in: the only route reachable without a token, because it issues
# them. Rate limited per source IP inside the Lambda, and by the stage throttle
# outside it.
# ---------------------------------------------------------------------------
resource "aws_apigatewayv2_route" "judge_login" {
  count = local.judge_voice_count

  api_id             = aws_apigatewayv2_api.voice_session[0].id
  route_key          = "POST /judge-sessions"
  target             = "integrations/${aws_apigatewayv2_integration.judge_login[0].id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_integration" "judge_login" {
  count = local.judge_voice_count

  api_id                 = aws_apigatewayv2_api.voice_session[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.judge_login[0].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_lambda_permission" "judge_login_api" {
  count = local.judge_voice_count

  statement_id  = "AllowApiGatewayInvokeLogin"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.judge_login[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.voice_session[0].execution_arn}/*/*"
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

  api_id    = aws_apigatewayv2_api.voice_session[0].id
  route_key = "POST /voice-sessions"
  target    = "integrations/${aws_apigatewayv2_integration.voice_session[0].id}"

  # CUSTOM, not JWT: on an HTTP API a Lambda (REQUEST) authorizer is attached
  # as CUSTOM. JWT is only for the built-in JWT authorizer, which this is not.
  # terraform validate does not catch the mismatch - it is rejected by the API
  # at apply time.
  authorization_type = "CUSTOM"
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
  description = "Stage A output, the API base URL. Set the WEBRTC_SESSION_URL Pages variable to this plus voice-sessions."
}

output "judge_voice_flow_id" {
  value       = one(aws_connect_contact_flow.judge_voice[*].contact_flow_id)
  description = "STAGE B output. Null until connect_judge_flow_enabled is true."
}

output "judge_lex_bot_alias_arn" {
  value       = local.judge_voice_enabled ? local.judge_lex_bot_alias_arn : null
  description = "Stage A output. Required by the manual Connect association in the bridge."
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

# ---------------------------------------------------------------------------
# The two judge-auth Lambdas.
#
# They share one IAM role: both run the same auth composition, both read the
# same access-code digest, both touch the same table partition. Two roles with
# identical policies would be two things to keep in step.
#
# Neither has any Connect permission. Sign-in and authorization cannot start a
# contact, whatever else is misconfigured.
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "judge_auth" {
  for_each = local.judge_voice_enabled ? toset(["judge-login", "judge-authorizer"]) : toset([])

  name              = "/aws/lambda/${local.name_prefix}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "judge_auth" {
  count = local.judge_voice_count

  name = "${local.name_prefix}-judge-auth"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "judge_auth" {
  count = local.judge_voice_count

  name = "${local.name_prefix}-judge-auth-runtime"
  role = aws_iam_role.judge_auth[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteFunctionLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.name_prefix}-judge-*:*"
      },
      {
        # Sessions are keyed by token hash, and the login limiter uses the same
        # table. No Scan: nothing here ever enumerates sessions.
        Sid      = "ReadWriteJudgeSessions"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.procurement[0].arn
      },
      {
        Sid      = "ReadJudgeAccessCodeDigest"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = data.aws_secretsmanager_secret.judge_access_code[0].arn
      },
    ]
  })
}

data "archive_file" "judge_login" {
  count = local.judge_voice_count

  type        = "zip"
  source_dir  = "${path.module}/build/judgeLogin"
  output_path = "${path.module}/build/judgeLogin.zip"
}

data "archive_file" "judge_authorizer" {
  count = local.judge_voice_count

  type        = "zip"
  source_dir  = "${path.module}/build/judgeAuthorizer"
  output_path = "${path.module}/build/judgeAuthorizer.zip"
}

locals {
  judge_auth_environment = {
    JUDGE_AUTH_ENABLED          = "true"
    PROCUREMENT_TABLE           = local.judge_voice_table_name
    JUDGE_ACCESS_CODE_SECRET_ID = local.judge_voice_enabled ? data.aws_secretsmanager_secret.judge_access_code[0].arn : ""
    ALLOWED_ORIGIN              = var.judge_portal_origin
    JUDGE_SESSION_TTL_MS        = tostring(var.judge_session_ttl_minutes * 60000)
    LOGIN_ATTEMPTS_PER_WINDOW   = tostring(var.judge_login_attempts_per_window)
  }
}

resource "aws_lambda_function" "judge_login" {
  count = local.judge_voice_count

  function_name = "${local.name_prefix}-judge-login"
  description   = "Exchanges the judge access code for a short-lived opaque session token."
  role          = aws_iam_role.judge_auth[0].arn

  filename         = data.archive_file.judge_login[0].output_path
  source_code_hash = data.archive_file.judge_login[0].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"

  # PBKDF2 at 100k+ iterations is deliberately slow; 10s is ample and bounds a
  # request that somehow stalls reading the secret.
  timeout     = 10
  memory_size = 512

  environment {
    variables = local.judge_auth_environment
  }

  depends_on = [aws_cloudwatch_log_group.judge_auth]
}

resource "aws_lambda_function" "judge_authorizer" {
  count = local.judge_voice_count

  function_name = "${local.name_prefix}-judge-authorizer"
  description   = "API Gateway authorizer: resolves an opaque judge token to a server-minted judgeId."
  role          = aws_iam_role.judge_auth[0].arn

  filename         = data.archive_file.judge_authorizer[0].output_path
  source_code_hash = data.archive_file.judge_authorizer[0].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"

  # On the hot path of every API call: one hash and one point read.
  timeout     = 5
  memory_size = 256

  environment {
    variables = local.judge_auth_environment
  }

  depends_on = [aws_cloudwatch_log_group.judge_auth]
}

output "judge_login_endpoint" {
  value       = local.judge_voice_enabled ? "${aws_apigatewayv2_stage.voice_session[0].invoke_url}judge-sessions" : null
  description = "Stage A output. Set VITE_JUDGE_LOGIN_URL to this."
}

output "judge_lex_bot_id" {
  value       = one(aws_lexv2models_bot.judge_voice[*].id)
  description = "Stage A output. Needed by the manual locale build in the deployment bridge."
}
