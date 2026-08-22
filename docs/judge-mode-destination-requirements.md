# Live Judge Mode — destination support (future requirement)

**Not implemented.** Recorded here so it is not lost, and so the current
development guardrail is not mistaken for a product decision.

## The current allowlist is temporary

`JudgeBackendService` accepts `+1, +33, +44, +48, +49`, and
`src/ui/judgeModeConfig.ts` derives a locale from those same five codes.

That is a **development guardrail**, not a product requirement. A real
hackathon judge may hold a number from any CALL-E-supported destination — for
example `+63` (Philippines). Under today's code that judge simply cannot use
Live Judge Mode.

## Intended design before public deployment

1. Accept any syntactically valid E.164 number.
2. Resolve and validate destination support **server-side**, against what
   CALL-E actually supports.
3. Allow any CALL-E-supported destination.
4. Keep the spoken locale **independent** of the phone-country code.

So this must be valid:

```
phone:              +63…
destination region: Philippines
conversation locale: en-US
```

`deriveLocaleFromPhone` may keep suggesting a default, but it must stop being
the gate that decides whether a call is allowed at all.

## What actually controls abuse

Destination allowlisting was never the real control. These are:

- backend-verified access code (PBKDF2-SHA256, constant-time)
- short-lived session, opaque token stored only as a hash
- exactly one call per session, atomic conditional claim
- explicit consent
- rate limiting
- global call budget
- kill switch

All already implemented. Widening destinations does not weaken any of them.

## Independent of supplier infrastructure

These five calling codes must **not** influence supplier runtime design. The
supplier path uses the existing controlled +1 Connect number for every persona,
whatever language is spoken. The two concerns share nothing but a phone.
