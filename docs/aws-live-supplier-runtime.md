# AWS live supplier runtime

Infrastructure for **one controlled English CALL-E qualification**. Nothing in
this document has been deployed, and no real call has been placed.

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
| Recording storage | Terraform native | `aws_connect_instance_storage_config` |
| **Lex V2 bot alias** | **Cloud Control** | `awscc_lex_bot_alias` — no `aws_lexv2models_bot_alias` exists ([#35780](https://github.com/hashicorp/terraform-provider-aws/issues/35780), [#36044](https://github.com/hashicorp/terraform-provider-aws/issues/36044)) |
| **Connect ↔ Lex V2 association** | **Controlled CLI step** | `aws_connect_bot_association` is Lex V1 only ([#30869](https://github.com/hashicorp/terraform-provider-aws/issues/30869)) |
| Number → flow assignment | Manual | Connect console, during approved deployment only |

The alias uses Cloud Control because the Lambda permission and the Lambda's own
guard both reference it — outside state those references cannot resolve at plan
time. The Connect association stays a CLI step: one idempotent command in the
runbook is safer than putting a half-supported resource into state where a
later plan might try to "correct" it.

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

## Recording — optional but enabled

Enabled by default (`enable_call_recording`). Private bucket, public access
blocked, SSE-S3, 30-day lifecycle, bucket policy scoped to this Connect
instance by `aws:SourceArn`, TLS required.

Recording is **not** a decision source. Authority stays with the CALL-E
structured result, the transcript evidence and the deterministic Policy
Gateway. Nothing under `src/` reads this bucket.

Both parties are ours and every persona is fictional, so there is no personal
data and SSE-S3 is sufficient. Recording a real human would require their
consent and disclosure, and should be reconsidered then.

## Not deployed in this change

The StockGuard **caller** is not deployed. Phase 1 found that
`CallEApiAdapter.startedCallsByWorkflow` and the manager-call adapter's
idempotency maps are **process memory**. Those are per-workflow and
per-session limits on real, paid phone calls — on Lambda they do not survive a
cold start or concurrency, so they are not adequate financial safety
boundaries. The first qualification will use a deliberately controlled local
harness, subject to separate approval.
