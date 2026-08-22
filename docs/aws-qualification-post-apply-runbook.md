# AWS qualification post-apply runbook

Starts exactly where `Terraform Apply` ends and stops at the single
qualification call. Nothing here has been performed.

Terraform deploys the runtime but deliberately does **not** wire it to the
telephone. Three things stay manual, each because it is irreversible in a way a
plan review cannot protect you from:

| Manual step | Why it is not in Terraform |
|---|---|
| Connect ↔ Lex V2 association | `aws_connect_bot_association` is Lex V1 only ([#30869](https://github.com/hashicorp/terraform-provider-aws/issues/30869)) |
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
`supplier_simulator_function_name` and `simulator_enabled`. An empty output
means the apply did not complete; stop and re-read the apply log rather than
continuing by hand.

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
**numbered** version rather than `DRAFT`; the StockGuard contact flow; and that
no StockGuard recording configuration was attached.

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

## 5. Associate the qualification alias with Connect

The provider gap makes this a one-off CLI step. Terraform prints the exact
command, already filled in:

```bash
terraform output -raw manual_connect_association_command
```

Run what it prints. It is idempotent. It grants Connect permission to invoke
the alias; it does not route any call to it and does not change the phone
number.

---

## 6. Verify the association, read-only

```bash
aws connect list-bots --region eu-central-1 \
  --instance-id "$AWS_CONNECT_INSTANCE_ID" --lex-version V2 --output table
```

The qualification alias ARN must now appear alongside whatever was already
there. Re-running the step 2 script will also report the association as present.

**Stop here** unless the qualification stage is explicitly approved. At this
point the runtime is fully deployed, fully verified, connected to Lex — and
answers no telephone number, with a supplier that refuses every turn. That is a
deliberate resting state, and it is safe to leave indefinitely.

---

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
| `enable_call_recording` | `false` |

This selects the **qualification** plan policy automatically. That policy
accepts exactly one change — an `update` to
`aws_lambda_function.supplier_simulator` that flips `SIMULATOR_ENABLED` from
`"false"` to `"true"` — and rejects any create, delete, replacement, any update
to any other resource, and any change to the function's role, runtime, timeout,
memory, reserved concurrency or other environment variables. Nothing else can
ride along with the arming.

The direction is checked, not just the destination: a plan whose prior state is
not `"false"` is refused, so this mode cannot be used to disarm. Step 9.2 is the
mirror image and is the only path that can.

**8b. Verify the Lambda is armed.**

```bash
scripts/qualification/verifyAwsRuntime.sh \
  --outputs /tmp/sg-outputs.json \
  --instance-id "$AWS_CONNECT_INSTANCE_ID" \
  --expect-simulator true --expect-recording false
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
   `simulator_enabled=false`, `enable_call_recording=false`. This runs under
   the **initial** policy, which permits exactly one update — to
   `aws_lambda_function.supplier_simulator`, changing `SIMULATOR_ENABLED` from
   `"true"` to `"false"` and nothing else. Every other managed resource must be
   create, read or no-op, and the function's role, runtime, handler, timeout,
   memory, reserved concurrency and every other environment variable must be
   unchanged — the same protections that apply to arming. If state has drifted
   so that disarming would destroy, replace or update anything else, the gate
   stops the apply and you disarm by hand instead.
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

## Recording stays off

`enable_call_recording` remains `false`, and both workflows refuse to plan or
apply with it set to `true` — the mode selector fails closed before an AWS
credential is even requested.

The reason is narrow and fixable: attaching a `CALL_RECORDINGS` storage
configuration **replaces** whatever the Connect instance already has, and that
baseline has not been captured. Recording is genuinely useful for debugging a
first live call, so this is worth revisiting — but only after
`aws connect list-instance-storage-configs --resource-type CALL_RECORDINGS`
proves the instance has no existing configuration, and only as a deliberate
change to the policy that currently rejects it.

Recording is never a decision source. Authority stays with the CALL-E
structured result, the transcript evidence and the deterministic Policy
Gateway.

---

## What this runbook deliberately does not contain

No account id, no phone number, no bot id, no flow id, no ARN. Every
identifier is read at run time from Terraform outputs or from GitHub
configuration. Fill them into your own notes, not into this file.
