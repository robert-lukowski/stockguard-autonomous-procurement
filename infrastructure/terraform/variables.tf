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
