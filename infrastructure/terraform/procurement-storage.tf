# ---------------------------------------------------------------------------
# Durable procurement state.
#
# One table, single-table design, holding two entity families that share the
# same lifecycle and the same TTL attribute:
#
#   PSESSION#<sessionId>   procurement session, quotes, evaluations,
#                          single-use confirmation tokens, audit events
#   VOICEGRANT#<sessionId> single-use Amazon Connect WebRTC grants
#   RATE#<judgeId>         per-judge fixed-window rate-limit counters
#
# Created only when var.procurement_table_enabled is true, which defaults to
# false. Nothing in CI sets it.
#
# This table is deliberately SEPARATE from any Judge Mode table. The two have
# different retention, different access patterns and different blast radius,
# and sharing one would mean a single IAM grant covering both.
# ---------------------------------------------------------------------------
resource "aws_dynamodb_table" "procurement" {
  count = var.procurement_table_enabled ? 1 : 0

  name         = var.procurement_table_name
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "PK"
  range_key = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  # Every item written by the adapters carries expiresAtEpoch. TTL is cleanup,
  # never access control: deletion is best-effort and can lag by hours, so the
  # adapters check expiry in code as well.
  ttl {
    attribute_name = "expiresAtEpoch"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  # A table holding live procurement sessions and consumed single-use tokens
  # must not be removable by an accidental plan. Both guards are deliberate:
  # deletion_protection_enabled stops the AWS API call, prevent_destroy stops
  # Terraform proposing it in the first place.
  deletion_protection_enabled = true

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Application = "stockguard"
    Component   = "procurement-core"
  }
}

# ---------------------------------------------------------------------------
# Least-privilege access for a future procurement Lambda.
#
# The policy document exists whether or not the table does, so the permissions
# are reviewable in a plan before any stateful resource is created. It is not
# attached to any role here: no Lambda serves the procurement core yet, and
# attaching a policy to nothing would be misleading.
#
# Scoped to this one table. No Scan, no DeleteItem, no wildcard: the adapters
# use Get, Query, Put and UpdateItem only, and an unused verb in a policy is
# an unnecessary capability.
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "procurement_table_access" {
  count = var.procurement_table_enabled ? 1 : 0

  statement {
    sid    = "ReadWriteProcurementSessions"
    effect = "Allow"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]

    resources = [aws_dynamodb_table.procurement[0].arn]
  }
}

output "procurement_table_name" {
  value       = one(aws_dynamodb_table.procurement[*].name)
  description = "Null unless var.procurement_table_enabled is true."
}

output "procurement_table_access_policy" {
  value       = one(data.aws_iam_policy_document.procurement_table_access[*].json)
  description = "Least-privilege policy for a future procurement Lambda. Not attached to any role."
}
