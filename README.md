# StockGuard

Autonomous multilingual procurement with independently validated, policy-bounded execution.

StockGuard predicts an inventory shortage, uses CALL-E to collect comparable offers from approved suppliers in their preferred languages, validates original-language evidence against deterministic procurement policy, and creates a synthetic purchase order only when every control passes. If no offer complies, it escalates a tightly bounded operational decision to a human manager without allowing a voice-based policy override or order.

## Current foundation

The React 19 product dashboard currently provides:

- one predicted CF-220 stockout;
- three approved suppliers in Germany, France, and Poland;
- normalized multilingual offers;
- an independent validation result;
- a machine-enforced policy proof;
- a synthetic purchase order;
- an operator kill switch;
- guided and configurable public scenarios;
- a mock Judge Mode manager-escalation path;
- explicit workflow states, bounded retries, timeout and cancellation behavior;
- evidence-aware structured result validation;
- idempotent workflow and synthetic-order controls;
- SHA-256 audit chaining and an ECDSA-signed Decision Proof v2.

The manager escalation preview demonstrates:

`NO_COMPLIANT_OFFER → HUMAN_ESCALATION_REQUIRED → MANAGER_CALLING → MANAGER_RESPONSE_RECEIVED → PROOF_SIGNED`

A request such as “increase the budget and buy anyway” is deterministically converted to `REQUIRES_AUTHENTICATED_HUMAN_APPROVAL`. It does not change policy and does not create an order.

No real calls, purchases, suppliers, organizations, or production data are used.

## Run locally

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run lint
npm test
npm run build
```

## Judge Mode and safety boundary

The public app uses mock CALL-E results and synthetic data. The live CALL-E adapters remain fail-closed. The frontend-to-backend Judge Mode contract contains no valid access code or credential and refuses to transmit data when no backend URL is configured.

The intended live flow uses a backend-verified Devpost code, a short-lived one-call session, explicit consent, idempotency, rate limiting, country/number controls, a global kill switch and minimal retention. Real telephone calls and paid AWS infrastructure remain disabled until explicitly authorized.

See [Judge Mode — Manager Escalation](docs/judge-mode-manager-escalation.md) for the state model, API contract, proposed AWS deployment, guardrails, failure behavior and implementation roadmap.

## Decision Proof wording

StockGuard produces a **cryptographically signed, machine-verifiable decision record with tamper-evident audit chaining**.

The proof verifies the integrity and signer origin of the StockGuard record. It does not prove that a supplier or manager statement is true, provide strong identity verification, or constitute a legal signature or non-repudiation mechanism.
