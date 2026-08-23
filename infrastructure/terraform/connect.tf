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
# Lex V2 association — the reason CreateContactFlow was failing.
#
# Amazon Connect VALIDATES a flow at creation time. A flow referencing a Lex
# bot alias that is not associated with the instance is rejected outright with
# InvalidContactFlowException, which is what every apply hit: Terraform created
# the alias and the flow in the same run, with the association sitting outside
# Terraform as a manual `aws connect associate-bot` step. Even when that step
# had been run by hand, it had been run against a PREVIOUS alias id — AWSCC
# mints a new one whenever the alias is recreated — so at CreateContactFlow
# time the current alias was still unassociated.
#
# `aws_connect_bot_association` is Lex V1 only
# (hashicorp/terraform-provider-aws#30869), which is why the step was manual.
# But AWS::Connect::IntegrationAssociation accepts a Lex V2 bot-alias ARN under
# IntegrationType LEX_BOT, so the awscc provider ALREADY IN THIS STACK closes
# the gap. That removes the manual step rather than adding machinery, and it
# makes the ordering a dependency edge Terraform enforces instead of a runbook
# instruction someone has to remember.
# ---------------------------------------------------------------------------
resource "awscc_connect_integration_association" "lex_bot" {
  # This property takes the instance ARN, not the bare instance id.
  instance_id      = local.connect_instance_arn
  integration_arn  = local.lex_bot_alias_arn
  integration_type = "LEX_BOT"
}

# ---------------------------------------------------------------------------
# The contact flow: the smallest thing that proves the vertical slice
#   Connect -> Lex V2 alias -> Lambda synthetic supplier.
#
# Deliberately three actions. Everything previously here was either optional or
# actively unhelpful for a first qualification call:
#
#   UpdateContactTextToSpeechVoice  removed. Joanna is the documented default
#                                   when the action never runs, and the Lex
#                                   locale carries its own voice settings.
#   MessageParticipant (greet)      removed. ConnectParticipantWithLexBot takes
#                                   an optional Text parameter that plays the
#                                   same greeting while gathering input, so a
#                                   separate action and its error branch were
#                                   pure surface area.
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
        Transitions = { NextAction = "lex" }
      },
      {
        Identifier = "lex"
        Type       = "ConnectParticipantWithLexBot"
        Parameters = {
          # Text plays while gathering input. It is mutually exclusive with
          # PromptId and SSML, neither of which is set.
          LexV2Bot = { AliasArn = local.lex_bot_alias_arn }
          Text     = "Ridgeline Industrial Supply, sales desk. How can I help?"
        }
        Transitions = {
          NextAction = "disconnect"
          # NoMatchingError must always be defined on an action that can error.
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

  # The alias ARN is already a reference, so Terraform orders the flow after
  # the alias. This edge adds the association, which the flow does not
  # reference but which AWS requires to exist before it will accept the flow.
  depends_on = [awscc_connect_integration_association.lex_bot]
}
