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

  # Remote state. The bucket is NOT created by this configuration - it is a
  # one-time manual bootstrap, because Terraform cannot hold its own backend.
  # Left commented so `terraform init` works locally for fmt/validate before
  # the bucket exists. Uncomment during the separately approved deployment.
  #
  # backend "s3" {
  #   bucket       = "stockguard-tfstate-<account-id>"
  #   key          = "runtime/terraform.tfstate"
  #   region       = "eu-central-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}
