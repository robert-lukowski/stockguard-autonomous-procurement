# ---------------------------------------------------------------------------
# Amazon Lex V2 - Architecture A, English only.
#
# PROVIDER GAP, re-verified against hashicorp/aws ~> 6.0:
#   hashicorp/aws has no `aws_lexv2models_bot_alias` resource.
#   Tracked as hashicorp/terraform-provider-aws#35780 and #36044, both open.
#
# We use `awscc_lex_bot_alias` from the Cloud Control provider rather than a
# CLI step, because the alias is referenced by the Lambda invoke permission and
# by the Lambda's own environment guard. Leaving it outside state would make
# those two references unresolvable during plan. Cloud Control is a HashiCorp
# provider over the AWS Cloud Control API, so this is not an unstable
# third-party dependency.
#
# The Connect <-> Lex V2 association is a different story - see connect.tf.
# ---------------------------------------------------------------------------

resource "aws_lexv2models_bot" "supplier_simulator" {
  name        = "${local.name_prefix}-supplier-simulator"
  description = "Deterministic synthetic supplier used to qualify the CALL-E telephony path."
  role_arn    = aws_iam_role.lex_bot.arn
  type        = "Bot"

  # No customer data of any kind: both sides of the call are ours and every
  # persona is fictional.
  data_privacy {
    child_directed = false
  }

  idle_session_ttl_in_seconds = 300
}

data "aws_iam_policy_document" "lex_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lexv2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lex_bot" {
  name               = "${local.name_prefix}-lex-bot"
  description        = "Service role assumed by the Lex V2 bot."
  assume_role_policy = data.aws_iam_policy_document.lex_assume.json
}

# AmazonLexV2BotPolicy lives under the AWS `aws-service-role/` path and cannot
# be attached to a customer-managed role. Its effective permission for this
# voice bot is Polly speech synthesis, so keep that single permission inline
# rather than broadening the role with a generic Polly managed policy.
resource "aws_iam_role_policy" "lex_bot" {
  name = "polly-synthesis"
  role = aws_iam_role.lex_bot.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "SynthesizeSpeech"
      Effect   = "Allow"
      Action   = "polly:SynthesizeSpeech"
      Resource = "*"
    }]
  })
}

resource "aws_lexv2models_bot_locale" "en" {
  bot_id                           = aws_lexv2models_bot.supplier_simulator.id
  bot_version                      = "DRAFT"
  locale_id                        = local.lex_locale_id
  n_lu_intent_confidence_threshold = 0.40

  voice_settings {
    voice_id = "Joanna"
    engine   = "neural"
  }
}

# --- Intents -----------------------------------------------------------------
# Architecture A needs no slots: there is one fixed profile and no routing code
# to capture. The handler's `qualificationRfqId` entry mode supplies the RFQ.

resource "aws_lexv2models_intent" "get_supplier_quote" {
  bot_id      = aws_lexv2models_bot.supplier_simulator.id
  bot_version = aws_lexv2models_bot_locale.en.bot_version
  locale_id   = aws_lexv2models_bot_locale.en.locale_id
  name        = "GetSupplierQuote"
  description = "CALL-E asks whether the material is available and at what price."

  sample_utterance { utterance = "I am calling about a purchase request" }
  sample_utterance { utterance = "Do you have this part in stock" }
  sample_utterance { utterance = "How many units are available" }
  sample_utterance { utterance = "What is the unit price" }
  sample_utterance { utterance = "Can you quote me for this material" }
  sample_utterance { utterance = "I need a quote" }
  sample_utterance { utterance = "When could you deliver" }

  fulfillment_code_hook {
    enabled = true
  }
}

resource "aws_lexv2models_intent" "confirm_commercial_terms" {
  bot_id      = aws_lexv2models_bot.supplier_simulator.id
  bot_version = aws_lexv2models_bot_locale.en.bot_version
  locale_id   = aws_lexv2models_bot_locale.en.locale_id
  name        = "ConfirmCommercialTerms"
  description = "The follow-up that surfaces the changed payment terms."

  sample_utterance { utterance = "Are the commercial terms unchanged" }
  sample_utterance { utterance = "What are the payment terms" }
  sample_utterance { utterance = "Has anything changed in the terms" }
  sample_utterance { utterance = "Are your standard terms still valid" }

  fulfillment_code_hook {
    enabled = true
  }
}

resource "aws_lexv2models_intent" "end_conversation" {
  bot_id      = aws_lexv2models_bot.supplier_simulator.id
  bot_version = aws_lexv2models_bot_locale.en.bot_version
  locale_id   = aws_lexv2models_bot_locale.en.locale_id
  name        = "EndConversation"
  description = "Closes the synthetic quote conversation."

  sample_utterance { utterance = "That is everything thank you" }
  sample_utterance { utterance = "Thank you goodbye" }
  sample_utterance { utterance = "That is all I needed" }

  fulfillment_code_hook {
    enabled = true
  }
}

# FallbackIntent is built in and always present. The Lambda guard fails closed
# on anything it does not recognise, so no extra resource is required here.

resource "aws_lexv2models_bot_version" "v1" {
  bot_id = aws_lexv2models_bot.supplier_simulator.id

  locale_specification = {
    (local.lex_locale_id) = {
      source_bot_version = "DRAFT"
    }
  }

  depends_on = [
    aws_lexv2models_intent.get_supplier_quote,
    aws_lexv2models_intent.confirm_commercial_terms,
    aws_lexv2models_intent.end_conversation,
  ]
}

# The runtime alias. The Lex TestBotAlias is explicitly NOT used: it always
# tracks DRAFT, so runtime behaviour would change the moment anyone edits the
# bot in the console.
resource "awscc_lex_bot_alias" "supplier_simulator" {
  bot_id         = aws_lexv2models_bot.supplier_simulator.id
  bot_alias_name = local.lex_alias_name
  bot_version    = aws_lexv2models_bot_version.v1.bot_version
  description    = "Versioned runtime alias used by the Connect contact flow."

  bot_alias_locale_settings = [{
    locale_id = local.lex_locale_id

    bot_alias_locale_setting = {
      enabled = true

      code_hook_specification = {
        lambda_code_hook = {
          lambda_arn                  = aws_lambda_function.supplier_simulator.arn
          code_hook_interface_version = "1.0"
        }
      }
    }
  }]
}
