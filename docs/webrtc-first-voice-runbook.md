# First live voice test — two-stage deployment

Everything below is **prepared, not executed**. No AWS call has been made, no
Terraform has been applied, and no Amazon Connect contact has been started.

Read [ADR 0001](./adr-0001-webrtc-judge-portal.md) first for why the
architecture is shaped this way.

---

## What the judge does

1. Open the Judge Portal.
2. Type the supplied access code, press **Sign in**.
3. Click **Start Voice Demo**, allow the microphone.
4. Say: *"I need twenty industrial SSD drives within a week."*

No account, no identity provider, no JWT to paste.

## What the path does

```
Judge Portal (browser)
  → POST /judge-sessions       access code → short-lived opaque token
  → POST /voice-sessions       Bearer token → Lambda authorizer → judgeId
  → VoiceSessionService        rate limit, single-use grant
  → Amazon Connect StartWebRTCContact
  → browser joins via Amazon Chime SDK
  → Connect contact flow       (stockguard-judge-voice)
  → Lex V2 bot                 RequestProcurement / ConfirmPurchase / DeclinePurchase
  → judge-voice Lambda         ProcurementOrchestrator
  → closed catalog → Supplier Tool → 13-check Policy Gateway + mission checks
  → spoken summary + confirmation request
  → DynamoDB, CloudWatch EMF metrics
```

Everything after the Lex bot already runs end to end with no AWS at all:
`src/server/procurement/lexVoiceHandler.test.ts` drives a spoken request to a
created purchase request in process.

---

## Why two stages

Amazon Connect validates a contact flow against its Lex bot association **at
creation time**, and that association is a manual CLI step —
`aws_connect_bot_association` is Lex V1 only
([#30869](https://github.com/hashicorp/terraform-provider-aws/issues/30869)).
Terraform cannot sequence a manual step, so a single apply races it and fails
with `InvalidContactFlowException`. That has already happened twice on the
supplier flow.

`var.connect_judge_flow_enabled` (default `false`) is the mechanical guard:
Stage A physically cannot create the flow, and the session Lambda deploys with
no flow id and no `StartWebRTCContact` permission, so it refuses every request
rather than failing mid-call.

---

## Before either stage

**1. Create the access-code secret.** Manually, outside Terraform. Pick a code,
derive a PBKDF2-SHA256 digest, store the digest — never the code:

```bash
node -e '
const { pbkdf2Sync, randomBytes } = require("node:crypto");
const code = process.argv[1];
const salt = randomBytes(16);
const iterations = 210000;
console.log(JSON.stringify({
  algorithm: "PBKDF2-SHA256",
  saltBase64: salt.toString("base64"),
  derivedKeyBase64: pbkdf2Sync(code, salt, iterations, 32, "sha256").toString("base64"),
  iterations,
}));' "YOUR-ACCESS-CODE" > /tmp/judge-secret.json

aws secretsmanager create-secret \
  --name stockguard/judge/access-code \
  --secret-string file:///tmp/judge-secret.json \
  --region eu-central-1

shred -u /tmp/judge-secret.json
```

The plaintext code goes to the judges and nowhere else. It is never committed,
never a Pages variable, and never logged.

**2. Build the Lambda bundles.** `terraform plan` reads them from disk and
fails if they are absent:

```bash
npm ci
npm run build:lambda
```

Produces six bundles under `infrastructure/terraform/build/`, including
`judgeLogin/`, `judgeAuthorizer/`, `judgeVoice/` and `voiceSession/`. The AWS
SDK is marked external — the Node 22 Lambda runtime provides v3.

---

## Stage A — everything except Amazon Connect

```bash
cd infrastructure/terraform
terraform init

terraform plan -out=stage-a.tfplan \
  -var 'webrtc_judge_mode_enabled=true' \
  -var 'procurement_table_enabled=true'
```

**Review the plan.** It must create:

| Resource | Name |
|---|---|
| DynamoDB table | `stockguard-procurement` |
| Lambda | `stockguard-qualification-judge-login` |
| Lambda | `stockguard-qualification-judge-authorizer` |
| Lambda | `stockguard-qualification-judge-voice` |
| Lambda | `stockguard-qualification-voice-session` |
| IAM roles | `…-judge-auth`, `…-judge-voice`, `…-voice-session`, `…-judge-lex-bot` |
| HTTP API + REQUEST authorizer + `$default` stage | `stockguard-qualification-voice-session` |
| Routes | `POST /judge-sessions` (no auth), `POST /voice-sessions` (authorizer) |
| Lex V2 | bot, `en_US` locale (built automatically), version, `judge` alias |
| CloudWatch log groups | four |

It must **not** create a contact flow, a phone number, a Lambda Function URL,
or anything with `authorization_type = "NONE"` outside the sign-in route.

```bash
terraform apply stage-a.tfplan
```

### Verify Stage A

```bash
terraform output judge_login_endpoint        # https://…/judge-sessions
terraform output voice_session_endpoint      # https://…
terraform output judge_lex_bot_alias_arn     # needed by the bridge below

# The locale was built by the apply; confirm it before continuing.
aws lexv2-models describe-bot-locale --region eu-central-1 \
  --bot-id "$(terraform output -raw judge_lex_bot_id)" \
  --bot-version DRAFT --locale-id en_US --query botLocaleStatus --output text
# → Built

# Sign-in works and issues a token.
curl -sS -X POST "$(terraform output -raw judge_login_endpoint)" \
  -H 'content-type: application/json' \
  -d '{"accessCode":"YOUR-ACCESS-CODE"}'
# → {"status":"AUTHENTICATED","token":"<64 hex>","expiresAt":"..."}

# A wrong code is refused.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$(terraform output -raw judge_login_endpoint)" \
  -H 'content-type: application/json' -d '{"accessCode":"WRONG"}'
# → 401

# The voice route rejects an unauthenticated call.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  "$(terraform output -raw voice_session_endpoint)/voice-sessions" \
  -H 'content-type: application/json' -d '{"sessionId":"x","missionId":"MISSION-SSD-20"}'
# → 401

# With a token it reaches the Lambda, which refuses because Stage B has not run.
curl -sS -X POST "$(terraform output -raw voice_session_endpoint)/voice-sessions" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"sessionId":"x","missionId":"MISSION-SSD-20"}'
# → 409 {"status":"REFUSED","reason":"DISABLED",...}   <- expected in Stage A
```

That last 409 is the proof Stage A is correctly incomplete: authentication
works, and no contact can be started.

---

## Manual bridge — associate the Lex alias

Only one step, because it is the only thing Terraform genuinely cannot do.
Stage A already built the Lex locale and cut the version from it; that is
automated by `terraform_data.judge_locale_build`, the same pattern `lex.tf`
uses for the supplier bot.

**B1. Associate the alias with the Connect instance.** Terraform prints the
exact command; it is idempotent.

```bash
terraform output -raw judge_manual_connect_association_command
# then run what it prints
```

**B2. Verify the association.** The alias ARN from Stage A must appear:

```bash
aws connect list-bots --region eu-central-1 \
  --instance-id "$AWS_CONNECT_INSTANCE_ID" --lex-version V2 --output table
```

If it does not, **stop**. Stage B will fail with `InvalidContactFlowException`.

---

## Stage B — the Connect flow

```bash
terraform plan -out=stage-b.tfplan \
  -var 'webrtc_judge_mode_enabled=true' \
  -var 'procurement_table_enabled=true' \
  -var 'connect_judge_flow_enabled=true'
```

The plan must show exactly two changes: **create**
`aws_connect_contact_flow.judge_voice`, and **update in place** the
`voice-session` Lambda environment and IAM policy (gaining the flow id and
`StartWebRTCContact`). Nothing else.

```bash
terraform apply stage-b.tfplan
```

### Verify Stage B

```bash
terraform output judge_voice_flow_id     # now non-null

# Same authenticated call as before; now it starts a contact.
curl -sS -X POST "$(terraform output -raw voice_session_endpoint)/voice-sessions" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"missionId\":\"MISSION-SSD-20\"}"
```

> This starts a **billable Amazon Connect voice contact**. `$SESSION_ID` must be
> a procurement session the portal actually created; an invented one returns
> 404 and costs nothing.

---

## Publish the Judge Portal

Set three **repository variables** (Settings → Secrets and variables → Actions
→ Variables). All three are public, non-secret values:

| Variable | Value |
|---|---|
| `WEBRTC_JUDGE_MODE` | `true` — exactly; `TRUE`, `1`, `yes` all leave it off |
| `WEBRTC_SESSION_URL` | `<voice_session_endpoint>/voice-sessions` |
| `JUDGE_LOGIN_URL` | `<judge_login_endpoint>` |

`deploy-pages.yml` forwards these three plus the existing
`QUALIFICATION_BACKEND_URL`. **Never** put the access code, a session token or
an AWS credential in a Pages variable: the built bundle is public.

Re-run the **Deploy demo to GitHub Pages** workflow.

---

## The test itself

1. Open the portal. Mission card: Industrial SSD, 20 units, USD 2,500, within
   7 days.
2. Enter the access code, **Sign in**.
3. **Run the mission** once, to open a procurement session.
4. **Start Voice Demo**, allow the microphone.
5. Say *"I need twenty industrial SSD drives within a week."* Expect a spoken
   reply naming 98.00 USD per unit, 1,960.00 USD total, asking whether to
   create the purchase request.
6. Say *"yes"*. Expect a spoken purchase-request confirmation.
7. **End**.

Then, in a fresh session, say *"I need forty industrial SSD drives within a
week"*: expect a spoken refusal citing `mission_budget`, with no confirmation
offered.

---

## AWS resources and what costs money

| Resource | Stage | Cost |
|---|---|---|
| DynamoDB table (on-demand, PITR) | A | pennies at demo volume; PITR is the larger share |
| 4 Lambdas + 4 log groups | A | negligible |
| HTTP API, authorizer, stage | A | per request |
| Lex V2 bot, locale, version, alias | A | per speech request |
| Connect contact flow | B | free to define |
| Secrets Manager secret | manual | ~USD 0.40/month |

**Cost-bearing operations:**

- `StartWebRTCContact` — an Amazon Connect **voice contact**, billed per
  minute. The only expensive operation on the path, and it exists only after
  Stage B.
- Lex speech recognition and Polly synthesis, per utterance.

Bounded by: the access code (no anonymous caller), 10 sign-in attempts per
source IP per 15 minutes, a 30-minute session token, three contacts per judge
per hour in DynamoDB, an API stage throttle of 2 rps / burst 5, one grant per
procurement session, and a 300-second Lex idle session TTL.

**No PSTN call is possible on this path.** The judge-voice Lambda holds no
CALL-E credential and no telephony permission — DynamoDB and logs only.

---

## Rollback

1. Set `WEBRTC_JUDGE_MODE` to anything but `true` and re-run Pages. The portal
   falls back to the local text channel immediately.
2. `terraform apply` with `connect_judge_flow_enabled=false` removes the flow
   and the `StartWebRTCContact` grant. No contact can be started after this,
   and everything else keeps working.
3. `terraform apply` with `webrtc_judge_mode_enabled=false` removes the API,
   all four Lambdas, the Lex bot and the roles.
4. **The DynamoDB table will not be destroyed** — `prevent_destroy` and
   `deletion_protection_enabled` both block it. Intentional: it holds consumed
   single-use tokens and audit chains. Remove it deliberately, by hand, only
   when the data is genuinely disposable.
5. Delete the Secrets Manager secret only if the access code is being retired.

## Deferred until after the first live voice test

Recorded, not implemented: KMS Decision Proof signing, Managed Grafana
dashboards, an exhaustive negative-test matrix, UI polish, multiple missions
and randomized scenarios, multilingual support, production rate-limit tuning,
and a standalone text-first Judge Mode.
