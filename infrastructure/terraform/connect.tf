# ---------------------------------------------------------------------------
# Amazon Connect.
#
# REUSED, never created or claimed by this configuration:
#   - the existing 'robert-support' instance (var.connect_instance_id)
#   - the existing controlled US +1 phone number
#
# The number is NOT assigned to this flow here. Assignment happens only during
# a separately approved deployment, so merging this PR cannot make the number
# start answering into a new flow.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Lex V2 association: MANUAL, and a known ordering hazard.
#
# `aws_connect_bot_association` is Lex V1 only
# (hashicorp/terraform-provider-aws#30869), so the association is performed
# once by hand with the command in outputs.tf.
#
# ORDERING HAZARD, because it has already bitten twice:
#   Amazon Connect validates a flow at CreateContactFlow time and rejects one
#   whose Lex alias is not associated with the instance. While the association
#   is manual, Terraform cannot sequence it against this flow, so whenever the
#   alias is recreated the association must be re-run by hand BEFORE the next
#   apply, or flow creation fails with InvalidContactFlowException.
# ---------------------------------------------------------------------------

# The association EXISTS in AWS, created by the manual associate-bot step, and
# a broken record of it exists in Terraform state from the apply that failed
# with AlreadyExists. Those two do not match: re-declaring the resource makes
# Terraform plan a REPLACE, and every property of
# AWS::Connect::IntegrationAssociation is create-only, so a replace would
# DESTROY the live association - the exact thing CreateContactFlow is
# validated against.
#
# `removed` with destroy = false drops the stale state entry and touches
# nothing in AWS. Terraform simply stops tracking it; the association survives.
# Management reverts to the manual step, which is where it was before.
removed {
  from = awscc_connect_integration_association.lex_bot

  lifecycle {
    destroy = false
  }
}

# ---------------------------------------------------------------------------
# The contact flow: the smallest thing that proves the vertical slice
#   Connect -> Lex V2 alias -> Lambda synthetic supplier.
#
# Deliberately six actions: logging, automated-interaction recording, a greeting
# that completes before Lex listens, the primary Lex turn, one bounded retry,
# and disconnect.
#
#   UpdateContactTextToSpeechVoice  removed. Joanna is the documented default
#                                   when the action never runs, and the Lex
#                                   locale carries its own voice settings.
#   MessageParticipant (greet)      KEPT separate from Lex. The first live calls
#                                   proved that playing Text while Lex gathers
#                                   input permits barge-in and messy turn-taking.
#   MessageParticipant (goodbye)    removed, along with the error-path variant.
#                                   Neither is needed to prove the path works.
#
#   UpdateFlowLoggingBehavior       KEPT. It has no error surface at all (the
#                                   flow language defines no errors for it) and
#                                   the flow log is the only instrument we get
#                                   for debugging the first real call.
# ---------------------------------------------------------------------------
resource "aws_connect_contact_flow" "supplier_simulator" {
  instance_id = var.connect_instance_id
  name        = "${local.name_prefix}-synthetic-supplier"
  description = "Answers CALL-E on the controlled number and hands the caller to the deterministic Lex supplier."
  type        = "CONTACT_FLOW"

  content = jsonencode({
    Version     = "2019-10-30"
    StartAction = "set-logging"

    Actions = [
      {
        Identifier  = "set-logging"
        Type        = "UpdateFlowLoggingBehavior"
        Parameters  = { FlowLoggingBehavior = "Enabled" }
        Transitions = { NextAction = "enable-recording" }
      },
      {
        Identifier = "enable-recording"
        Type       = "UpdateContactRecordingBehavior"
        Parameters = {
          RecordingBehavior = {
            # Required by the Connect flow-language shape. An empty list keeps
            # agent/customer recording off while IVR recording is controlled
            # independently by the feature toggle.
            RecordedParticipants = []
            IVRRecordingBehavior = var.enable_call_recording ? "Enabled" : "Disabled"
          }
        }
        # The flow-language action has no result conditions or error branches.
        Transitions = { NextAction = "supplier-greeting" }
      },
      {
        Identifier = "supplier-greeting"
        Type       = "MessageParticipant"
        Parameters = {
          # Previous longer greeting kept here only as context for the live
          # turn-taking fix: Ridgeline Industrial Supply, sales desk. How can I help you today?
          Text = "Ridgeline Industrial Supply."
        }
        Transitions = {
          NextAction = "lex-primary"
          Errors = [
            { ErrorType = "NoMatchingError", NextAction = "disconnect" },
          ]
        }
      },
      {
        Identifier = "lex-primary"
        Type       = "ConnectParticipantWithLexBot"
        Parameters = {
          LexV2Bot = { AliasArn = local.lex_bot_alias_arn }
          # Keep the supplier side from being cut off while Lex is speaking a
          # realized response. CALL-E may still detect normal pauses, but its
          # audio cannot barge into the active Lex prompt.
          LexSessionAttributes = {
            "x-amz-lex:allow-interrupt:*:*" = "false"
          }
          # Connect still carries a very short prompt while it opens the Lex
          # listening turn. Previous prompt: Text = "Please go ahead."
          Text = "Go ahead."
        }
        Transitions = {
          # Default: any Lex result other than the bot's own FallbackIntent
          # (a real intent match, or a completed/EndConversation turn) falls
          # through here and disconnects. This is what protects a successful
          # goodbye from ever being retried.
          NextAction = "disconnect"
          # The bot's built-in fallback intent is literally named
          # "FallbackIntent" (confirmed via `aws lexv2-models list-intents`
          # against the live bot; its parentIntentSignature is
          # AMAZON.FallbackIntent, but Connect conditions match the intent's
          # own name, not the built-in signature). Only this one case gets
          # the bounded retry.
          Conditions = [
            {
              NextAction = "lex-retry"
              Condition = {
                Operator = "Equals"
                Operands = ["FallbackIntent"]
              }
            },
          ]
          Errors = [
            { ErrorType = "NoMatchingCondition", NextAction = "disconnect" },
            { ErrorType = "NoMatchingError", NextAction = "lex-retry" },
          ]
        }
      },
      {
        Identifier = "lex-retry"
        Type       = "ConnectParticipantWithLexBot"
        Parameters = {
          LexV2Bot = { AliasArn = local.lex_bot_alias_arn }
          LexSessionAttributes = {
            "x-amz-lex:allow-interrupt:*:*" = "false"
          }
          # Deliberately does not presume a question was already asked: the
          # FallbackIntent that lands here may fire before the caller has
          # completed their first procurement question. Previous wording:
          # Sorry, I didn't catch that clearly. Please go ahead.
          Text = "Sorry, could you repeat that?"
        }
        Transitions = {
          # No intent branching here: a second FallbackIntent has nowhere to
          # go but this same default disconnect, so there is no retry loop.
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
