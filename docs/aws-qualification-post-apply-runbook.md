# AWS qualification post-apply runbook

Starts exactly where `Terraform Apply` ends and stops at the single
qualification call.

> **Corrected 2026-09-04.** This runbook previously said "nothing here has been
> performed". That is not supportable: `infrastructure/terraform/connect.tf`
> records live calls reaching the flow and an apply that failed with
> `AlreadyExists`, and step 5 below already notes that mis-ordering "has already
> cost one failed apply". Which individual steps were performed, and in what
> order, is **not** recorded in this repository — read the AWS account rather
> than trusting any claim here.
>
> This path is no longer on the MVP. See
> [ADR 0001](./adr-0001-webrtc-judge-portal.md).

Terraform deploys the runtime but deliberately does **not** wire it to the
telephone. Three things stay manual, each because it is irreversible in a way a
plan review cannot protect you from:

| Manual step | Why it is not in Terraform |
|---|---|
| +1 number → contact flow | Reassigning the number takes an existing number away from whatever answers it today |
| Arming the simulator | Making a machine answer a phone call is a decision, not a deployment detail |

Do these in order. Do not skip step 3.

---

## 1. Verify the Terraform outputs

```bash
cd infrastructure/terraform
terraform output -json > /tmp/sg-outputs.json
terraform output          # visually confirm every output resolved
```

Expect `lex_bot_id`, `lex_bot_alias_id`, `lex_bot_alias_arn`, `contact_flow_id`,
`supplier_simulator_function_name`, `simulator_enabled`,
`recording_bucket_name`, `recording_prefix` and `recording_kms_key_arn`. An
empty output means the apply did not complete; stop and re-read the apply log
rather than continuing by hand.

`simulator_enabled` must read `false` at this point.

---

## 2. Run the read-only verification

The apply workflow runs this automatically. Run it again yourself if you are
picking up after someone else, or after any manual change:

```bash
scripts/qualification/verifyAwsRuntime.sh \
  --outputs /tmp/sg-outputs.json \
  --instance-id "$AWS_CONNECT_INSTANCE_ID" \
  --region eu-central-1 \
  --expect-simulator false \
  --expect-recording false
```

Every call it makes is a `describe`/`list`/`get`. It never invokes the Lambda,
never starts a Lex conversation, never modifies Connect and never places a call
— `scripts/qualification/verifyAwsRuntime.test.ts` enforces that by parsing the
script and rejecting any mutating verb.

It confirms: the Lambda exists on `nodejs22.x` with `SIMULATOR_ENABLED=false`,
a bounded reserved concurrency and a resource policy naming `lexv2.amazonaws.com`;
the Lex bot, its built `en_US` locale and a `qualification` alias pointing at a
**numbered** version rather than `DRAFT`; the StockGuard contact flow; and, when
recording is enabled, that the pre-existing Connect bucket, prefix and KMS key
still match the configured runtime assumptions. Terraform does not own or
replace that association.

It reports one item as `MANUAL` rather than checking it: **whether any phone
number is routed to the StockGuard flow**. No AWS API exposes that association
— `describe-phone-number` returns `TargetArn`, which identifies the Connect
instance, not the inbound contact flow. An earlier version of the script
compared those two values and reported a `PASS`; that comparison could never
fail, so it was evidence of nothing and has been removed. Step 3 below is how
that question actually gets answered.

Fix any `FAIL` before going further. A failure here is cheaper than a failure
mid-call. A `MANUAL` line is not a failure, but it is not a pass either — the
closing summary counts them so a run with outstanding manual items cannot be
mistaken for a clean bill of health.

---

## 3. Capture the current +1 inbound flow — BEFORE changing anything

**This is the one step with no undo if you skip it.**

The AWS phone-number APIs do not expose the inbound contact flow a claimed
number is currently associated with. `describe-phone-number` returns the
`TargetArn` (the Connect instance), not the flow. So the only record of what
that number answers with today is the one you make now, by hand:

1. Amazon Connect console → **Channels → Phone numbers**
2. Open the existing +1 number
3. Write down, verbatim, the **contact flow / IVR** currently selected
4. Screenshot it

Store that with your deployment notes. Step 9 cannot restore what step 3 did
not record.

While you are there, note whether the number has a description or hours-of-
operation profile attached.

---

## 4. Capture the current Lex V2 associations

```bash
aws connect list-bots --region eu-central-1 \
  --instance-id "$AWS_CONNECT_INSTANCE_ID" --lex-version V2 --output table
```

Record what is already associated. Associating a new bot is additive, so this
is a rollback record rather than a conflict check — but if the instance already
carries an alias with the same name, resolve that before continuing.

---

## 5. Associate the qualification alias with Connect — BEFORE the flow exists

`aws_connect_bot_association` is Lex V1 only
([#30869](https://github.com/hashicorp/terraform-provider-aws/issues/30869)),
so this is a manual step. Terraform prints the exact command:

```bash
terraform output -raw manual_connect_association_command
```

**Order matters, and getting it wrong has already cost one failed apply.**
Amazon Connect validates a flow at creation time and rejects one whose Lex
alias is not associated with the instance, with `InvalidContactFlowException`.
Because the association is manual, nothing sequences it for you. Run it
**before** the apply that creates `aws_connect_contact_flow`, and run it again
whenever the alias id changes — AWSCC mints a new one every time the alias is
recreated.

The command is idempotent; re-running it for an already-associated alias is
harmless.

## 6. Verify the association, read-only

```bash
aws connect list-bots --region eu-central-1 \
  --instance-id "$AWS_CONNECT_INSTANCE_ID" --lex-version V2 --output table
```

The alias from `terraform output -raw lex_bot_alias_arn` must appear before you
apply. If it does not, stop — flow creation will fail.

## 7. Do NOT assign the +1 number yet

Assignment is the point of no return for whatever that number does today. It
belongs to the qualification stage, not to deployment. Continue only when the
operator has decided to run the call now.

Terraform does not assign the number: this configuration declares no
phone-number resource, and the plan safety gate refuses any plan that
introduces one. That is an argument from the configuration, though, not an
observation of the live instance — the console remains the only place the
current association can actually be read.

---

## 8. Qualification stage

Perform these in this order. The order matters: arming a supplier that no call
can reach is safe, and routing calls to a supplier that refuses every turn is
safe, but doing them in the reverse order opens a window where a real inbound
call reaches a live synthetic supplier.

**8a. Arm the simulator through the controlled Terraform path.**

Actions → Terraform Apply → Run workflow on `main`:

| Input | Value |
|---|---|
| `confirm` | `APPLY` |
| `simulator_enabled` | `true` |
| `enable_call_recording` | `true` |

The workflow creates a saved plan that arms the simulator and enables the
recording action plus read-only lookup against the pre-existing Connect
storage. Review that plan before approval. It must not create an S3 bucket or
a `CALL_RECORDINGS` storage association.

**8b. Verify the Lambda is armed.**

```bash
scripts/qualification/verifyAwsRuntime.sh \
  --outputs /tmp/sg-outputs.json \
  --instance-id "$AWS_CONNECT_INSTANCE_ID" \
  --expect-simulator true --expect-recording true
```

**8c. Assign the existing +1 number to the StockGuard flow.**

Connect console → Phone numbers → the +1 number → set the contact flow to
`stockguard-qualification-synthetic-supplier`. Save.

You are now reachable. Everything from here is time-boxed.

**8d. Place exactly one qualification call.**

```bash
QUALIFICATION_ARMED=I-UNDERSTAND-THIS-PLACES-A-REAL-CALL \
  node scripts/qualification/en-supplier-qualification.mjs
```

The harness places one call per invocation, refuses any destination outside
`+1`, and requires a TTY plus a typed `PLACE-CALL`. Capture the call id, the
`structured_result`, and the transcript turns.

**8e. Roll back immediately afterwards.** Do not leave the number pointed at
StockGuard between attempts. Go to step 9, then return to 8c for a second
attempt if one is needed.

---

## 9. Rollback

In this order, and none of it is conditional on the call having failed —
step 9 runs after a successful qualification too.

1. **Restore the +1 contact flow.** Connect console → the number → select the
   flow you recorded in step 3. Save. Verify by reopening the number.
2. **Disarm the simulator.** Terraform Apply with `confirm=APPLY`,
   `simulator_enabled=false`, `enable_call_recording=false`. Review the saved
   plan: it should disarm the simulator, disable IVR recording for this flow and
   remove the caller's optional recording lookup IAM. It must not modify the
   external bucket or Connect storage association.
3. **Remove the Lex association only if you need to.** It is inert once the
   number no longer routes to the StockGuard flow, so prefer leaving it:
   ```bash
   aws connect disassociate-bot --region eu-central-1 \
     --instance-id "$AWS_CONNECT_INSTANCE_ID" \
     --lex-v2-bot AliasArn=<alias-arn-from-terraform-output>
   ```
4. **Do not destroy unrelated existing resources.** Never run
   `terraform destroy`: the Connect instance and the phone number are not in
   this state, but the contact flow is, and destroying it while the number
   still points at it breaks the number. Restore the number first (step 9.1),
   always.

---

## Recording reuses the existing Connect storage

The read-only inspection confirmed an existing `CALL_RECORDINGS` association.
StockGuard never creates, imports or replaces it. `enable_call_recording=true`
only enables IVR recording in this contact flow, grants the live caller scoped
read access to the existing bucket/prefix/KMS key, and enables the optional
Pages lookup/player.

Recording is never a decision source. Authority stays with the CALL-E
structured result, the transcript evidence and the deterministic Policy
Gateway.

---

## What this runbook deliberately does not contain

No phone number, bot id or flow id is committed. The pre-existing recording
bucket, prefix and KMS key ARN are explicit non-secret qualification defaults;
runtime-generated identifiers still come from Terraform outputs or GitHub
configuration.
