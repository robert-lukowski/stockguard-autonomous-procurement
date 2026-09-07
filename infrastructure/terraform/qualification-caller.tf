# ---------------------------------------------------------------------------
# PSTN live caller: RETIRED.
#
# ADR-0001 removed bot-to-bot PSTN from the MVP. The module was already gated
# off (count = 0 unless var.live_caller_enabled, which nothing sets), but an
# earlier apply had left its resources in the runtime state with no
# configuration left to reconcile against - so every plan reported them as
# orphaned destroys ("module.qualification_caller is not in configuration").
#
# This removed block turns that into one explicit, reviewed teardown. The next
# apply destroys exactly these six, and nothing else:
#
#   module.qualification_caller.aws_cloudwatch_log_group.this
#   module.qualification_caller.aws_iam_role.this
#   module.qualification_caller.aws_iam_role_policy.this
#   module.qualification_caller.aws_iam_role_policy.recordings[0]
#   module.qualification_caller.aws_lambda_function.this
#   module.qualification_caller.aws_lambda_function_url.this
#
# The CALL-E API-key secret is read as a data source, never managed here, so it
# is untouched.
#
# The ./modules/qualification-caller source and var.live_caller_enabled are
# left in place: they are inert with no module block referencing them, and
# removing them is follow-up cleanup once this teardown has been applied and
# this block itself can be dropped.
# ---------------------------------------------------------------------------
removed {
  from = module.qualification_caller

  lifecycle {
    destroy = true
  }
}
