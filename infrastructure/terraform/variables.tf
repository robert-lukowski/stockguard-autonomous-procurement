variable "aws_region" {
  type        = string
  default     = "eu-central-1"
  description = <<-EOT
    Region of the existing Amazon Connect instance. Lex V2 and Connect must
    share a region, so every runtime resource lives here even though the
    telephone number is a US +1 number.
  EOT

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region must be a valid AWS region identifier."
  }
}

variable "aws_account_id" {
  type        = string
  description = "Target account. Supplied at plan time, never committed."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be 12 digits."
  }
}

variable "connect_instance_id" {
  type        = string
  description = <<-EOT
    Existing Amazon Connect instance ID (the 'robert-support' sandbox).
    This configuration never creates a Connect instance and never claims a
    phone number.
  EOT
}

variable "environment" {
  type        = string
  default     = "qualification"
  description = "Deployment environment label used in names and tags."

  validation {
    condition     = contains(["qualification", "demo"], var.environment)
    error_message = "environment must be qualification or demo."
  }
}

variable "qualification_sku" {
  type        = string
  default     = "CF-220"
  description = "Synthetic material the English supplier quotes."
}

variable "qualification_quantity" {
  type        = number
  default     = 8
  description = "Synthetic quantity requested during qualification."

  validation {
    condition     = var.qualification_quantity > 0 && floor(var.qualification_quantity) == var.qualification_quantity
    error_message = "qualification_quantity must be a positive integer."
  }
}

variable "qualification_required_by" {
  type        = string
  default     = "2026-09-30T12:00:00+02:00"
  description = "Synthetic required-by date used to derive delivery answers."
}

variable "simulator_enabled" {
  type        = bool
  default     = false
  description = <<-EOT
    Master switch for the synthetic supplier Lambda.

    Defaults to false so that deploying the infrastructure does NOT by itself
    make the supplier answer calls. The simulator is turned on deliberately,
    as a separate act, immediately before a controlled qualification.
  EOT
}

variable "enable_call_recording" {
  type        = bool
  default     = false
  description = <<-EOT
    Use the pre-existing Amazon Connect CALL_RECORDINGS storage configuration
    for the controlled qualification demo. When true, the contact flow enables
    automated-interaction recording and the live caller exposes read-only
    recording lookup. Terraform never creates or owns the bucket or storage
    association.

    It is never a decision source: authority stays with the CALL-E structured
    result, the transcript evidence and the deterministic Policy Gateway.
  EOT
}

variable "recording_bucket_name" {
  type        = string
  default     = "amazon-connect-93f5db840470"
  description = "Pre-existing Amazon Connect CALL_RECORDINGS S3 bucket. Terraform does not own it."
}

variable "recording_prefix" {
  type        = string
  default     = "connect/robert-support/CallRecordings"
  description = "Pre-existing Amazon Connect CALL_RECORDINGS object prefix."
}

variable "recording_kms_key_arn" {
  type        = string
  default     = "arn:aws:kms:eu-central-1:854010287302:key/00a17f01-a252-43f7-a803-d3e5df363c9b"
  description = "Customer-managed KMS key used by the pre-existing Connect recording storage."
}

variable "log_retention_days" {
  type        = number
  default     = 7
  description = "CloudWatch retention. Set explicitly so logs cannot grow forever."
}

variable "live_caller_enabled" {
  type        = bool
  default     = false
  description = <<-EOT
    DANGEROUS. Creates the PSTN live-caller Lambda and a PUBLIC Lambda Function
    URL with authorization_type = "NONE". Every accepted POST to that URL places
    a real, paid outbound telephone call through the external CALL-E vendor.

    Defaults to false, and the Judge Portal MVP does not need it: the
    channel-independent procurement core in src/server/procurement runs the
    whole demo with no telephony at all.

    What actually bounds the endpoint when it IS enabled, stated exactly:
      - a server-side Judge PIN compared with timingSafeEqual;
      - a required x-confirm: PLACE-CALL header;
      - a fixed destination, SKU, quantity and deadline the caller cannot choose.

    What does NOT bound it, and must not be described as if it did:
      - there is NO server-side rate limit;
      - there is NO reserved concurrency;
      - CallEApiAdapter.startedCallsByWorkflow is a per-container Map, so it is
        NOT a durable or global call budget. It does not survive a cold start
        and is not shared across concurrent invocations.

    Do not set this to true without a durable, cross-invocation spend control.
  EOT
}

variable "procurement_table_enabled" {
  type        = bool
  default     = false
  description = <<-EOT
    Creates the DynamoDB table backing durable procurement sessions and WebRTC
    voice grants.

    Defaults to false because the Judge Portal MVP runs entirely on the
    in-memory store: the table is only needed once a deployed Lambda serves the
    procurement core, and creating a stateful resource is a decision rather
    than a deployment detail.

    The table is safe to create in isolation - it is new, it is never shared
    with the Judge Mode table, and nothing reads or writes it until a
    composition root is wired up. It is NOT safe to destroy once it holds live
    sessions, which is why it carries deletion protection and
    prevent_destroy.
  EOT
}

variable "procurement_table_name" {
  type        = string
  default     = "stockguard-procurement"
  description = "DynamoDB table for procurement sessions and WebRTC voice grants."
}

variable "webrtc_judge_mode_enabled" {
  type        = bool
  default     = false
  description = <<-EOT
    Master switch for WebRTC Judge Mode.

    Defaults to false. Turning it on is not sufficient on its own: a real
    ConnectWebRtcContactPort must also be supplied, and the protected backend
    session endpoint must exist. The repository ships only
    DisabledConnectWebRtcContactPort, which throws, so this flag alone cannot
    start a billable Amazon Connect contact.

    See docs/adr-0001-webrtc-judge-portal.md.
  EOT
}

variable "judge_auth_issuer" {
  type        = string
  default     = ""
  description = <<-EOT
    OIDC issuer URL for the Judge Portal's JWT authorizer.

    Empty by default, and that emptiness is a security control rather than a
    placeholder: local.judge_voice_enabled is false without it, so the session
    API cannot be created without an authorizer. There is no configuration in
    which the endpoint that starts a billable Amazon Connect contact is
    reachable unauthenticated.
  EOT
}

variable "judge_auth_audience" {
  type        = string
  default     = ""
  description = "OIDC audience (client id) accepted by the Judge Portal's JWT authorizer. Empty disables the voice stack."
}

variable "judge_portal_origin" {
  type        = string
  default     = "https://robert-lukowski.github.io"
  description = "The single browser origin allowed to call the voice session endpoint."
}

variable "voice_sessions_per_judge_per_hour" {
  type        = number
  default     = 3
  description = <<-EOT
    Per-judge ceiling on WebRTC contacts, enforced server-side in DynamoDB.

    Each contact is billable, so this is a cost control. The API stage carries
    its own throttle as well: that bounds request rate, this bounds how many
    contacts one identity can actually start.
  EOT

  validation {
    condition     = var.voice_sessions_per_judge_per_hour >= 1 && var.voice_sessions_per_judge_per_hour <= 20
    error_message = "voice_sessions_per_judge_per_hour must be between 1 and 20."
  }
}
