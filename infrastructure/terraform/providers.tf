provider "aws" {
  region = var.aws_region

  # Refuse to act against any account other than the intended one.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project     = "stockguard"
      ManagedBy   = "terraform"
      Environment = var.environment
      Scenario    = "synthetic-supplier-qualification"
    }
  }
}

provider "awscc" {
  region = var.aws_region
}
