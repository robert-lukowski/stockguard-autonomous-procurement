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
#
# PROVIDER GAP, re-verified against hashicorp/aws ~> 6.0:
#   `aws_connect_bot_association` supports Lex V1 bots only. LexV2 support is
#   tracked as hashicorp/terraform-provider-aws#30869, still open.
#
#   CLASSIFICATION: controlled AWS CLI step.
#
#   The association is therefore performed once, manually, with the command in
#   the outputs. A CLI call here is safer than reaching for a fragile or
#   unmaintained provider purely for architectural purity: it is one idempotent
#   command, it is visible in the deployment runbook, and it does not put a
#   half-supported resource into state where a later plan could try to
#   "correct" it.
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
        # Logging on: without the contact flow log we would be debugging the
        # first live call blind.
        Identifier  = "set-logging"
        Type        = "UpdateFlowLoggingBehavior"
        Parameters  = { FlowLoggingBehavior = "Enabled" }
        Transitions = { NextAction = "set-recording" }
      },
      {
        Identifier = "set-recording"
        Type       = "UpdateContactRecordingBehavior"
        Parameters = {
          RecordingBehaviorOption    = var.enable_call_recording ? "Enable" : "Disable"
          RecordingParticipantOption = "Both"
        }
        Transitions = { NextAction = "set-voice" }
      },
      {
        Identifier = "set-voice"
        Type       = "UpdateContactTextToSpeechVoice"
        Parameters = {
          TextToSpeechEngine = "Neural"
          TextToSpeechVoice  = "Joanna"
        }
        Transitions = { NextAction = "greet" }
      },
      {
        Identifier = "greet"
        Type       = "MessageParticipant"
        Parameters = {
          Text = "Ridgeline Industrial Supply, sales desk. How can I help?"
        }
        Transitions = { NextAction = "lex" }
      },
      {
        Identifier = "lex"
        Type       = "ConnectParticipantWithLexBot"
        Parameters = {
          LexV2Bot = {
            AliasArn = "arn:aws:lex:${var.aws_region}:${var.aws_account_id}:bot-alias/${aws_lexv2models_bot.supplier_simulator.id}/${awscc_lex_bot_alias.supplier_simulator.bot_alias_id}"
          }
        }
        Transitions = {
          NextAction = "goodbye"
          Errors = [
            { ErrorType = "NoMatchingCondition", NextAction = "goodbye" },
            { ErrorType = "NoMatchingError", NextAction = "error" }
          ]
        }
      },
      {
        Identifier  = "goodbye"
        Type        = "MessageParticipant"
        Parameters  = { Text = "Thank you for calling. Goodbye." }
        Transitions = { NextAction = "disconnect" }
      },
      {
        Identifier  = "error"
        Type        = "MessageParticipant"
        Parameters  = { Text = "Sorry, the sales desk is unavailable right now. Goodbye." }
        Transitions = { NextAction = "disconnect" }
      },
      {
        Identifier  = "disconnect"
        Type        = "DisconnectParticipant"
        Parameters  = {}
        Transitions = {}
      }
    ]
  })
}
