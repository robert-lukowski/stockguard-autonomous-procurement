# First live voice test — deployment inputs

Everything below is **prepared, not executed**. No AWS call has been made, no
Terraform has been applied, and no Amazon Connect contact has been started.

Read [ADR 0001](./adr-0001-webrtc-judge-portal.md) first for why the
architecture is shaped this way.

---

## What the path does

```
Judge Portal (browser)
  → microphone permission
  → POST /voice-sessions        (HTTP API + JWT authorizer)
  → VoiceSessionService         (identity, rate limit, single-use grant)
  → Amazon Connect StartWebRTCContact
  → browser joins via Amazon Chime SDK
  → Connect contact flow        (stockguard-judge-voice)
  → Lex V2 bot                  (RequestProcurement / ConfirmPurchase / DeclinePurchase)
  → judge-voice Lambda          (ProcurementOrchestrator)
  → closed catalog → Supplier Tool → 13-check Policy Gateway + mission checks
  → spoken summary + confirmation request
  → DynamoDB (session, quote, evaluation, single-use token, audit chain)
  → CloudWatch EMF metrics
```

Everything after the Lex bot already runs, end to end, with no AWS at all:
`src/server/procurement/lexVoiceHandler.test.ts` drives a spoken request to a
created purchase request in process.

---

## 1. Terraform variables

The voice stack is created only when **all four** hold. Any one missing leaves
`local.judge_voice_enabled` false and nothing is created.

| Variable | Value for the first test | Why |
|---|---|---|
| `webrtc_judge_mode_enabled` | `true` | master switch, default `false` |
| `procurement_table_enabled` | `true` | the orchestrator has nowhere to persist a run without it |
| `judge_auth_issuer` | your OIDC issuer URL | **no authorizer, no API** — this is structural |
| `judge_auth_audience` | your OIDC client id | same |

Optional, with working defaults:

| Variable | Default | Note |
|---|---|---|
| `judge_portal_origin` | `https://robert-lukowski.github.io` | the only origin allowed to call the endpoint |
| `voice_sessions_per_judge_per_hour` | `3` | per-judge contact ceiling, enforced in DynamoDB |
| `procurement_table_name` | `stockguard-procurement` | |
| `log_retention_days` | `7` | |

Leave `live_caller_enabled` and `simulator_enabled` at `false`. The PSTN path is
not part of this test.

## 2. Build the Lambda bundles first

`terraform plan` reads them from disk and fails if they are absent:

```bash
npm ci
npm run build:lambda
```

Produces `infrastructure/terraform/build/{judgeVoice,voiceSession}/index.js`.
The AWS SDK is marked external — the Node 22 Lambda runtime provides v3.

## 3. Plan and apply

```bash
cd infrastructure/terraform
terraform init   # needs registry.terraform.io; blocked in the agent sandbox

terraform plan -out=voice.tfplan \
  -var 'webrtc_judge_mode_enabled=true' \
  -var 'procurement_table_enabled=true' \
  -var 'judge_auth_issuer=https://YOUR-ISSUER' \
  -var 'judge_auth_audience=YOUR-CLIENT-ID'
```

**Review the plan before applying.** It must create the DynamoDB table, two
Lambdas, the Lex bot, the contact flow and the HTTP API — and must NOT create a
phone number, a Lambda Function URL, or anything with
`authorization_type = "NONE"`.

Then `terraform apply voice.tfplan`.

> The GitHub `Terraform Apply` workflow does not pass these variables, so it
> cannot deploy the voice stack. That is deliberate for now; wire them in only
> once the first manual test has succeeded.

## 4. Manual steps Terraform cannot do

**4a. Associate the Lex alias with Connect — BEFORE the apply that creates the flow.**

`aws_connect_bot_association` is Lex V1 only
([#30869](https://github.com/hashicorp/terraform-provider-aws/issues/30869)),
and Connect validates a flow against the association at creation time. Ordering
this wrong has already cost one failed apply on the supplier flow.

```bash
terraform output -raw judge_manual_connect_association_command   # prints it
```

If the first apply fails with `InvalidContactFlowException`, this is why: run
the association, then apply again.

**4b. Build the Lex locale.** Terraform creates intents but AWS builds the
locale asynchronously. Confirm in the Lex console that the `en_US` locale shows
**Built** before the first call, or the bot will not answer.

**4c. Point the portal at the endpoint.**

```bash
terraform output -raw voice_session_endpoint    # https://xxxx.execute-api.<region>.amazonaws.com
```

Set two GitHub repository variables for the Pages build:

| Variable | Value |
|---|---|
| `VITE_WEBRTC_JUDGE_MODE` | `true` (exactly; `TRUE`, `1`, `yes` all leave it off) |
| `VITE_WEBRTC_SESSION_URL` | `<voice_session_endpoint>/voice-sessions` |

`deploy-pages.yml` does not yet forward these — add them alongside
`VITE_QUALIFICATION_BACKEND_URL`, or build locally for the first test.

**4d. Issue a judge token.** The browser must send
`Authorization: Bearer <jwt>` from your OIDC provider, matching the configured
issuer and audience. Without it the API returns 401 and no contact is started.

## 5. The test itself

1. Open the Judge Portal. The mission card reads: Industrial SSD, 20 units,
   USD 2,500, within 7 days.
2. Click **Run the mission** once to open a procurement session.
3. Click **Start Voice Demo**, allow the microphone.
4. Say: *"I need twenty industrial SSD drives within a week."*
5. Expect a spoken reply naming 98.00 USD per unit, 1,960.00 USD total, and
   asking whether to create the purchase request.
6. Say *"yes"*. Expect a spoken purchase-request confirmation.
7. Click **End**.

Then say *"I need forty industrial SSD drives within a week"* in a fresh
session: expect a spoken refusal citing `mission_budget`, with no confirmation
offered.

## 6. AWS resources and what costs money

Created by the apply:

| Resource | Cost |
|---|---|
| DynamoDB table (on-demand, PITR) | pennies at demo volume; PITR is the larger share |
| 2 Lambda functions + 2 log groups | negligible |
| Lex V2 bot, locale, version, alias | per speech request |
| Connect contact flow | free to define |
| HTTP API + JWT authorizer + stage | per request |

**Cost-bearing operations**, all requiring an authenticated judge:

- `StartWebRTCContact` — an Amazon Connect **voice contact**, billed per minute.
  This is the only expensive operation on the path.
- Lex speech recognition and Polly synthesis, per utterance.

Bounded by: the JWT authorizer (no anonymous caller), three contacts per judge
per hour in DynamoDB, an API stage throttle of 2 rps / burst 5, one grant per
procurement session, and a 300-second Lex idle session TTL.

**No PSTN call is possible on this path.** The judge-voice Lambda holds no
CALL-E credential and no telephony permission — its IAM policy is DynamoDB and
logs only.

## 7. Rollback

1. Set `VITE_WEBRTC_JUDGE_MODE` to anything but `true` and rebuild Pages. The
   portal falls back to the local text channel immediately.
2. `terraform apply` with `webrtc_judge_mode_enabled=false` destroys the API,
   both Lambdas, the Lex bot and the flow.
3. **The DynamoDB table will not be destroyed** — `prevent_destroy` and
   `deletion_protection_enabled` both block it. That is intentional: it holds
   consumed single-use tokens and audit chains. Remove it deliberately, by hand,
   only when the data is genuinely disposable.

## Deferred until after the first live voice test

Recorded, not implemented: KMS Decision Proof signing, Managed Grafana
dashboards, an exhaustive negative-test matrix, UI polish, multiple missions and
randomized scenarios, multilingual support, production rate-limit tuning, and a
standalone text-first Judge Mode.
