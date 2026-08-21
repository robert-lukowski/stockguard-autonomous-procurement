# AWS read-only bootstrap

## Purpose

This bootstrap lets the manually triggered GitHub Actions workflow inspect the existing Amazon Connect sandbox without long-lived AWS credentials. It creates one dedicated IAM role and grants only the Connect read operations needed for a sanitized inventory.

It does **not** create or change an Amazon Connect instance, phone number, contact flow, Lambda function, Lex bot or DynamoDB table. It does not call phone-number or Secrets Manager APIs.

## Security model

- GitHub requests a short-lived OIDC token; no AWS access key is stored in GitHub.
- AWS STS credentials last 15 minutes for this workflow.
- The role trust accepts only the immutable subject for this repository's `main` branch.
- The trust includes both the immutable GitHub owner ID `207513888` and repository ID `1341560793`.
- The credentials action checks the expected 12-digit AWS account ID.
- IAM permissions contain only the required `List` operations for Amazon Connect and only in the configured sandbox Region.
- The workflow runs only through `workflow_dispatch` and verifies the repository, owner, event and branch before requesting AWS credentials.
- The inventory resolves the Connect instance by its expected alias; it fails if zero or multiple instances match.
- Logs and the job summary omit AWS account ID, instance ID, ARNs and Lambda names.
- Phone-number APIs and secret APIs are deliberately absent.

GitHub repositories created after July 15, 2026 use immutable OIDC subject claims containing owner and repository IDs. The StockGuard repository uses that format rather than the older name-only example. See the official [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc) and [AWS IAM GitHub OIDC guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html).

## One-time manual setup

### 1. Confirm the shared GitHub OIDC provider

In AWS IAM, open **Identity providers** and confirm that this account already contains:

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

The provider is account-level and can be reused by separate repository roles. Do not create a duplicate provider. If it is absent, add the OpenID Connect provider with exactly those values, following the official [GitHub AWS OIDC instructions](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).

### 2. Create the dedicated read-only role

In AWS CloudFormation:

1. Select the Region containing the `robert-support` Amazon Connect instance.
2. Create a stack by uploading `infrastructure/bootstrap/github-readonly-role.yml`.
3. Use stack name `stockguard-github-readonly`.
4. Set `AllowedRegion` to the Connect Region.
5. Acknowledge that the template creates a named IAM resource.
6. Create the stack.
7. Copy the `ReadOnlyRoleArn` stack output.

CloudFormation and the IAM role do not incur a separate hourly charge. No application resource is created by this template.

### 3. Add non-secret GitHub Actions variables

Open **Repository settings → Secrets and variables → Actions → Variables** and add:

| Variable | Value |
|---|---|
| `AWS_ACCOUNT_ID` | The 12-digit ID of the sandbox AWS account |
| `AWS_REGION` | The Region containing the Connect instance, for example `eu-central-1` |
| `AWS_ROLE_ARN` | The `ReadOnlyRoleArn` CloudFormation output |
| `AWS_CONNECT_INSTANCE_ALIAS` | `robert-support` |

These are configuration values, not AWS credentials. Do not create `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` secrets.

## Run the inventory

The workflow can authenticate only after this change has been merged to `main`:

1. Open **Actions → AWS Read-only Inventory**.
2. Select **Run workflow**.
3. Select branch `main`.
4. Run the workflow.

The sanitized summary reports:

- Region and Connect alias;
- instance status and inbound/outbound feature flags;
- contact-flow counts and any flow whose name contains `stockguard`;
- counts of associated Lambda functions and Lex V2 bots;
- integration counts grouped by type;
- explicit `phoneNumbersInspected: false` and `resourcesChanged: false` flags.

The workflow fails closed for a wrong repository, branch, account, Region, alias or OIDC trust relationship.

## What remains disabled

- infrastructure deployment;
- Connect phone-number claiming;
- creation or modification of contact flows;
- Lex, Lambda, DynamoDB, API Gateway or KMS provisioning;
- CALL-E credentials, webhooks and real calls;
- reading secrets, transcripts or phone numbers.

The read-only result will be used to tailor a later infrastructure plan to the existing sandbox. Any AWS write or potentially chargeable operation requires a separate reviewed workflow and explicit approval.
