# AWS qualification bootstrap runbook

One-time setup that must happen **outside** this repository before the first
Terraform plan can run. Nothing here has been performed: the authoring
environment has no working AWS credentials (STS returned
`InvalidClientTokenId`), so every step below is yours to run.

Do these in order. Steps 1–3 are AWS; steps 4–6 are GitHub.

---

## 1. Terraform state bucket

One bucket, `eu-central-1`, used only for Terraform state — never for
application data or recordings.

| Setting | Value |
|---|---|
| Region | `eu-central-1` |
| Name | globally unique, StockGuard-scoped, e.g. `stockguard-tfstate-<account-id>` |
| Versioning | **enabled** |
| Public access | **fully blocked** (all four settings) |
| Default encryption | **enabled** (SSE-S3 is sufficient) |
| Bucket policy | none |

Tags:

```
Project=stockguard-autonomous-procurement
Environment=hackathon-sandbox
Purpose=terraform-state
```

Locking uses native S3 conditional writes (`use_lockfile = true`). **Do not
create a DynamoDB lock table.**

If a bucket with the intended name already exists in the account, verify the
settings above and reuse it rather than creating a second one.

## 2. Deploy role CloudFormation stack

Template: `infrastructure/bootstrap/github-deploy-role.yml` (already reviewed
and merged — do not redesign it).

```
Stack name : stockguard-github-deploy-bootstrap
Region     : eu-central-1
Capability : CAPABILITY_NAMED_IAM
Parameters :
  AllowedRegion        = eu-central-1
  TerraformStateBucket = <bucket from step 1>
```

Check first whether the stack or the `stockguard-github-deploy` role already
exists. Reuse it if it matches. If it is in a `ROLLBACK`/`FAILED` state,
inspect that specific failure and repair only the blocker.

**Do not modify the existing read-only role** (`stockguard-github-readonly`)
or its workflow.

Capture the stack output `DeployRoleArn`.

## 3. Confirm the Connect instance

Read-only. Record the **instance id** for `robert-support` in `eu-central-1`.

While you are there, note two things that decide a later switch:

- whether a **`CALL_RECORDINGS` storage configuration already exists**
- the existing `+1` number's **current contact-flow association**, so it can be
  restored later

**Do not change the `+1` assignment in this phase.** The read-only inspection
confirmed the pre-existing `CALL_RECORDINGS` bucket, prefix and KMS key used by
the qualification defaults. StockGuard reuses that association and never
creates, imports or replaces recording storage.

## 4. GitHub environment

Create environment **`aws-qualification`**.

This is not optional. The deploy role's trust policy is bound to the OIDC
subject `…:environment:aws-qualification`, so without the environment the role
cannot be assumed at all.

Add the repository owner as a required reviewer if GitHub permits it for this
repository. If it does not, the environment must still exist — the remaining
gates stay in force regardless: `workflow_dispatch` only, `main` only, a typed
`APPLY` confirmation, the OIDC environment subject, and a concurrency guard.

## 5. GitHub secrets

| Secret | Value |
|---|---|
| `AWS_ACCOUNT_ID` | 12-digit account id |
| `AWS_CONNECT_INSTANCE_ID` | instance id from step 3 |
| `TERRAFORM_STATE_BUCKET` | bucket name from step 1 |

Secrets rather than variables: GitHub masks secrets from first use, and
masking is not retroactive. The bucket name is a secret because it commonly
embeds the account id.

## 6. GitHub variables

| Variable | Value |
|---|---|
| `AWS_REGION` | `eu-central-1` |
| `AWS_DEPLOY_ROLE_ARN` | `DeployRoleArn` from step 2 |

**Never store AWS access keys in GitHub.** Authentication is OIDC only.

`AWS_DEPLOY_ROLE_ARN` also acts as the switch that lets the plan job run at
all: while it is unset, the plan job is skipped and CI proves only `fmt`,
`init -backend=false` and `validate`.

---

## Then: the first plan

Run **Terraform Plan** via `workflow_dispatch` on `main`, leaving both inputs
at their defaults:

```
simulator_enabled     = false
enable_call_recording = false
```

The `validate` job runs credential-free, then `plan` assumes the role through
the `aws-qualification` environment, initializes the remote backend and
produces a plan. It never applies.

Expect the first plan to surface missing IAM permissions. **Do not broaden the
role pre-emptively** — let the plan name exactly what it needs.

Review the plan by hand and confirm it creates only the Architecture A
resources and touches nothing that already exists. Only then run **Terraform
Apply**, which additionally requires typing `APPLY` and passing environment
approval.
