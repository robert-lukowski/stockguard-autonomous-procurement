# ---------------------------------------------------------------------------
# Call recording - OPTIONAL AND DISABLED BY DEFAULT.
#
# Classification rationale: the resources are a private bucket, its public
# access block, encryption, a lifecycle rule and one bucket policy. That is
# cheap and well-supported, and recordings are the single best instrument for
# debugging what actually happens between CALL-E, Connect and Lex on the first
# real call. Re-running a failed live call costs more than storing a few MB.
#
# Recording is NOT a decision source. Authority stays with the CALL-E
# structured result, the transcript evidence and the deterministic Policy
# Gateway. Nothing in src/ reads from this bucket.
#
# Set enable_call_recording = false to skip it entirely; the qualification must
# never fail merely because recording is unavailable.
# ---------------------------------------------------------------------------

locals {
  recording_prefix          = "connect/${var.environment}/CallRecordings"
  recording_url_ttl_seconds = 300
}

resource "aws_s3_bucket" "recordings" {
  count  = var.enable_call_recording ? 1 : 0
  bucket = "${local.name_prefix}-call-recordings-${var.aws_account_id}"
}

resource "aws_s3_bucket_public_access_block" "recordings" {
  count  = var.enable_call_recording ? 1 : 0
  bucket = aws_s3_bucket.recordings[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "recordings" {
  count  = var.enable_call_recording ? 1 : 0
  bucket = aws_s3_bucket.recordings[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "recordings" {
  count  = var.enable_call_recording ? 1 : 0
  bucket = aws_s3_bucket.recordings[0].id

  rule {
    apply_server_side_encryption_by_default {
      # SSE-S3 rather than KMS: the audio is two synthetic parties, both ours,
      # with no personal data. A CMK would add cost, a key policy and another
      # failure mode for no privacy gain. Revisit if a real human is ever
      # recorded - which would also require their consent and disclosure.
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "recordings" {
  count  = var.enable_call_recording ? 1 : 0
  bucket = aws_s3_bucket.recordings[0].id

  rule {
    id     = "expire-qualification-recordings"
    status = "Enabled"

    filter {}

    expiration {
      days = var.recording_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.recording_retention_days
    }
  }
}

data "aws_iam_policy_document" "recordings" {
  count = var.enable_call_recording ? 1 : 0

  statement {
    sid    = "AllowConnectInstanceWrite"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["connect.amazonaws.com"]
    }

    actions = ["s3:PutObject", "s3:PutObjectAcl", "s3:GetBucketAcl"]
    resources = [
      aws_s3_bucket.recordings[0].arn,
      "${aws_s3_bucket.recordings[0].arn}/*",
    ]

    # Only our Connect instance may write here, not Connect in general.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [local.connect_instance_arn]
    }
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.recordings[0].arn,
      "${aws_s3_bucket.recordings[0].arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "recordings" {
  count  = var.enable_call_recording ? 1 : 0
  bucket = aws_s3_bucket.recordings[0].id
  policy = data.aws_iam_policy_document.recordings[0].json
}

resource "aws_connect_instance_storage_config" "call_recordings" {
  count         = var.enable_call_recording ? 1 : 0
  instance_id   = var.connect_instance_id
  resource_type = "CALL_RECORDINGS"

  storage_config {
    storage_type = "S3"

    s3_config {
      bucket_name   = aws_s3_bucket.recordings[0].id
      bucket_prefix = local.recording_prefix

      encryption_config {
        encryption_type = "KMS"
        key_id          = "alias/aws/s3"
      }
    }
  }
}
