# AWS live supplier runtime

Infrastructure for **one controlled English CALL-E qualification**.

> ## Deployment status — corrected 2026-09-04
>
> An earlier version of this document stated that nothing had been deployed and
> no real call had been placed. Repository evidence contradicts that, so the
> claim is corrected here. Facts and assumptions are kept separate.
>
> **Established by evidence in this repository:**
>
> - Live calls reached this contact flow. `infrastructure/terraform/connect.tf`
>   records that the greeting was split out of the Lex block because *"the first
>   live calls proved that playing Text while Lex gathers input permits barge-in
>   and messy turn-taking"*, and PR #63 (`3323391`, `3dcdf52`, `8966f66`) is a
>   series of turn-taking fixes for observed behaviour.
> - `terraform apply` ran against AWS at least twice. `connect.tf` describes an
>   ordering hazard that "has already bitten twice" and a broken Terraform state
>   entry left by "the apply that failed with `AlreadyExists`".
> - The Lex bot exists in AWS. `connect.tf` cites `aws lexv2-models list-intents`
>   run "against the live bot".
> - Call-disconnect instability during those calls is the stated reason for the
>   architecture pivot in [ADR 0001](./adr-0001-webrtc-judge-portal.md).
>
> **NOT established, and still open:**
>
> - No row of [`calle-live-qualification-matrix.md`](./calle-live-qualification-matrix.md)
>   has been filled in, so no CALL-E API observation is recorded.
> - Every row of [`calle-assumptions-register.md`](./calle-assumptions-register.md)
>   remains unverified. In particular, whether CALL-E returns `fieldEvidence`
>   and labels the callee `"user"` is still unknown.
> - Whether a full end-to-end run ever produced a valid structured result and a
>   policy decision is not recorded anywhere in this repository.
> - The exact dates, call count and outcomes are not recorded. Anyone stating
>   them should read the AWS account, not this document.
>
> Since the pivot, none of this is on the MVP path. See ADR 0001.

**This is no longer the primary architecture.** Bot-to-bot PSTN left the MVP in
[ADR 0001](./adr-0001-webrtc-judge-portal.md); what follows is preserved as the
design record of the inactive telephony path.

## What this proves

> Can CALL-E hold a real phone conversation with our deterministic synthetic
> supplier and return usable structured evidence?

Nothing more. Everything not needed to answer that question is deliberately
absent.

## Phone destination and spoken language are independent

The existing controlled **US +1 Amazon Connect number is the telephone endpoint
for every supplier persona**. A supplier's nationality is a scenario attribute,
not a PSTN destination:

| Persona | Spoken locale | Telephone destination |
|---|---|---|
| `EN_SUPPLIER` | `en_US` | existing +1 Connect number |
| `DE_SUPPLIER` | `de_DE` | the same +1 number |
| `FR_SUPPLIER` | `fr_FR` | the same +1 number |

No `+49`, `+33`, `+44` or `+48` number is required, now or later.

Whether CALL-E accepts a `+1` recipient with a `de-DE` or `fr-FR` spoken locale
is a **live qualification item**, not an architectural blocker. We test English
first and observe the rest rather than designing around a failure nobody has
seen.

## Two locale vocabularies

Never mixed, converted once at the boundary by `callELocaleFor`:

- **Lex V2 locale id** — underscore, `en_US`. An AWS identifier.
- **CALL-E spoken locale** — BCP 47 hyphen, `en-US`.

`EN_SUPPLIER` uses `en_US` because `en_GB` is already the routing locale and
the Connect runtime for the first qualification is US English.

## Architecture A — what is deployed

```
CALL-E → PSTN → existing +1 number → Contact Flow
       → Lex V2 (en_US) → Lambda (fixed EN profile) → deterministic answer
       → CALL-E structured result → evidence validation → Policy Gateway
```

Absent on purpose: DynamoDB, six-digit routing, multilingual switching, agent
queue, Step Functions, generative AI, Judge Mode.

### Qualification entry mode

Routing normally resolves an RFQ from a spoken six-digit code. The first
qualification does not test code recognition, so there is no routing turn to
carry an RFQ. `SupplierSimulatorLambdaGuard.qualificationRfqId` supplies one
fixed pre-registered RFQ instead.

This is an **additional** entry point, not a hole in the existing one: whenever
a session carries an RFQ, that one wins and the normal routing path runs
unchanged. Leave `qualificationRfqId` undefined for Architecture B.

### Why the EN persona has changed commercial terms

`CHANGED_PAYMENT_TERMS` drives `commercial_terms_unchanged` to `REQUIRES_HUMAN`,
so a successful qualification **cannot** accidentally produce a compliant offer
and a synthetic purchase order. The call proves the telephony and evidence
path, not an autonomous purchase.

## Terraform provider gaps

Re-verified against `hashicorp/aws ~> 6.0`:

| Integration | Classification | Handling |
|---|---|---|
| Lex V2 bot, locale, intents, version | Terraform native | `aws_lexv2models_*` |
| Contact flow | Terraform native | `aws_connect_contact_flow` |
| Recording storage | Pre-existing Amazon Connect infrastructure | Reused, never imported or managed |
| **Lex V2 bot alias** | **Cloud Control** | `awscc_lex_bot_alias` — no `aws_lexv2models_bot_alias` exists ([#35780](https://github.com/hashicorp/terraform-provider-aws/issues/35780), [#36044](https://github.com/hashicorp/terraform-provider-aws/issues/36044)) |
| **Connect ↔ Lex V2 association** | **Controlled CLI step** | `aws_connect_bot_association` is Lex V1 only ([#30869](https://github.com/hashicorp/terraform-provider-aws/issues/30869)) |
| Number → flow assignment | Manual | Connect console, during approved deployment only |

The alias uses Cloud Control because the Lambda permission and the Lambda's own
guard both reference it — outside state those references cannot resolve at plan
time. The Connect association stays a CLI step: one idempotent command in the
runbook is safer than putting a half-supported resource into state where a
later plan might try to "correct" it.

## Breaking the Lambda ↔ alias cycle

The Lex alias's code hook points at the Lambda. The Lambda originally guarded
on the alias **id**, which Terraform generates when it creates the alias — so
each resource needed the other, and `terraform validate` reported:

```
Cycle: aws_lambda_function.supplier_simulator, awscc_lex_bot_alias.supplier_simulator
```

The Lambda now guards on the alias **name** instead. Lex V2 sends both
`bot.aliasId` and `bot.aliasName`, and the name (`qualification`) is chosen by
us, so it identifies the alias just as precisely without the circular
reference.

Alias validation is not weakened. `aliasAllowed` accepts an event only when it
matches an explicitly allowlisted id **or** name, and rejects everything when
neither list holds anything — an unconfigured guard is never an open one.
Architecture B can go back to id allowlisting unchanged.

`aws_lambda_permission` still pins `source_arn` to the real generated alias id.
That is a separate resource, so it adds no cycle, and the permission is never
widened to all Lex aliases.

Resulting order: bot → Lambda → alias → permission.

## Required GitHub configuration

| Name | Kind | Why |
|---|---|---|
| `AWS_ACCOUNT_ID` | **Secret** | GitHub masks secrets from first use; a job-level variable is already in the environment before any `::add-mask::` could run, and masking is not retroactive |
| `AWS_CONNECT_INSTANCE_ID` | **Secret** | same |
| `AWS_REGION` | Variable | not sensitive |
| `AWS_DEPLOY_ROLE_ARN` | Variable | not sensitive, and its presence is what gates whether the plan job touches AWS at all |

`TERRAFORM_STATE_BUCKET` is also a secret, since the bucket name commonly
embeds the account id.

The plan workflow is split in two. The `validate` job runs on every pull
request with **no environment and no `id-token` permission**, so PR-triggered
code cannot obtain a deployment credential at all. The `plan` job is manual,
`main`-only, and carries `environment: aws-qualification` — the OIDC subject
the deploy role's trust policy demands. Without that environment the role
simply cannot be assumed.

Until `AWS_DEPLOY_ROLE_ARN` is set, the `plan` job is skipped and CI proves
`fmt`, `init -backend=false` and `validate` only, with an explicit notice
saying why. No credential is requested and no AWS API call is made.

See [the bootstrap runbook](./aws-qualification-bootstrap-runbook.md) for the
one-time AWS and GitHub setup.

## Remote state

`versions.tf` declares `backend "s3" {}` — a partial configuration. Bucket,
key, region, encryption and locking are supplied at `terraform init` time from
GitHub configuration, so no account identifier, bucket name or credential is
committed. Both workflows initialize the same state object at
`runtime/terraform.tfstate`.

Locking uses native S3 conditional writes, so there is no DynamoDB lock table.

`terraform init -backend=false` still works for credential-free validation.

## Provider lock file

Not committed yet. This repository's build environment cannot reach
`registry.terraform.io`, and a fabricated lock file would be worse than none.
The plan workflow uploads the lock file the runner genuinely generates as the
`terraform-provider-lock` artifact — download it and commit it to pin
providers reproducibly.

## Safety properties

- `simulator_enabled` defaults to **false**. Deploying does not make the
  supplier answer calls; that is a separate deliberate act.
- The Lambda bundle contains **zero external `require` calls** — no AWS SDK, no
  network, no secrets. Its role grants CloudWatch Logs and nothing else.
- `reserved_concurrent_executions = 2` bounds any runaway.
- The apply workflow has **no automatic trigger** and is bound to a protected
  environment whose OIDC subject the deploy role's trust policy requires — the
  gate is enforced by IAM, not only by GitHub.
- `realCallsEnabled` is untouched. No CALL-E credential exists in AWS.

## Recording — optional, using pre-existing Connect storage

Disabled by default (`enable_call_recording=false`). When enabled, the contact
flow records the automated interaction and the live caller reads only from the
pre-existing `amazon-connect-93f5db840470` bucket under
`connect/robert-support/CallRecordings`. The existing Connect association uses
its pre-existing customer-managed KMS key. Terraform does not create, import or
own the recording bucket or the `CALL_RECORDINGS` storage association.

Recording is **not** a decision source. Authority stays with the CALL-E
structured result, the transcript evidence and the deterministic Policy
Gateway. The browser receives only a short-lived presigned URL; the bucket
remains private.

## Not deployed in this change

The StockGuard **caller** is not deployed. Phase 1 found that
`CallEApiAdapter.startedCallsByWorkflow` and the manager-call adapter's
idempotency maps are **process memory**. Those are per-workflow and
per-session limits on real, paid phone calls — on Lambda they do not survive a
cold start or concurrency, so they are not adequate financial safety
boundaries. The first qualification will use a deliberately controlled local
harness, subject to separate approval.
