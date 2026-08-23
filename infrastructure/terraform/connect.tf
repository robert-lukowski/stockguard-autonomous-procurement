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
}
