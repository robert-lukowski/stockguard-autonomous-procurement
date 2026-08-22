terraform {
  # 1.11+ is required for native S3 state locking (use_lockfile), which lets us
  # avoid provisioning a DynamoDB lock table for a single-operator project.
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    # Cloud Control provider, used ONLY for the Lex V2 bot alias, which
    # hashicorp/aws does not implement. See lex.tf for the justification.
    awscc = {
      source  = "hashicorp/awscc"
      version = "~> 1.0"
    }
    # Packages the pre-built Lambda bundle. No AWS access.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  # Remote state, declared as a PARTIAL configuration on purpose.
  #
  # Bucket, key, region and locking are supplied at `terraform init` time from
  # GitHub configuration, so no account identifier, bucket name or credential
  # is ever committed here. `terraform init -backend=false` still works for
  # credential-free fmt/validate in CI and locally.
  #
  # Locking uses native S3 conditional writes (use_lockfile), so there is no
  # DynamoDB lock table to provision or pay for.
  backend "s3" {}
}
