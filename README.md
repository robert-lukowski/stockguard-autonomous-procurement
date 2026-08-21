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
- SHA-256 audit chaining and an ECDSA-signed Decision Proof v2;
- a framework-neutral, locally tested Judge Mode backend core;
- API Gateway/Lambda handler contracts plus DynamoDB conditional-write and
  Secrets Manager adapters, all still undeployed;
- a deterministic, multilingual Supplier Simulator domain service and
  fail-closed Lex V2 handler contract for a future Amazon Connect test harness;
- explicit RFQ/profile/routing metadata in the CALL-E supplier-call contract;
- an undeployed DynamoDB supplier-data adapter with short RFQ expiry,
  transactional routing-key creation and optimistic profile versioning;
- a manual, OIDC-authenticated AWS read-only inventory workflow and a
  repository-specific IAM role template for the existing Connect sandbox.

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

The local backend core implements these semantics through mockable ports. It uses PBKDF2-SHA256 for the access-code verifier, stores only opaque-token and phone hashes, atomically consumes one call per session, deduplicates webhook IDs and rejects every webhook while provider authenticity verification is unconfigured.

The repository now also contains framework-neutral API Gateway/Lambda handler contracts, DynamoDB command adapters for conditional session claims, rate limits, the global call budget and webhook deduplication, plus a Secrets Manager access-code adapter. Supplier-side contracts include an allowlisted Connect test-number boundary, a six-digit short-lived routing code, RFQ/profile/dataset correlation and version-pinned synthetic data. They are tested as code only: no AWS SDK composition root, stack or resource has been deployed, and the live CALL-E path remains disabled. KMS signing still requires a live backend adapter.

The no-compliant-offer demo now sources its three repeatable synthetic supplier profiles from a dedicated data service. A future Amazon Connect/Lex/Lambda deployment can expose the same profiles as a conversational test counterparty, including a follow-up about missing quantity. This is a test harness, not the claimed business value: production CALL-E calls would target supplier humans, sales desks, IVRs or existing telephony systems when no current API/EDI integration exists.

See [Judge Mode — Manager Escalation](docs/judge-mode-manager-escalation.md) for the state model, API contract, proposed AWS deployment, guardrails, failure behavior and implementation roadmap.

See [Synthetic Supplier Simulator](docs/synthetic-supplier-simulator.md) for the one-number multilingual routing design, deterministic profiles, Lex intents, runtime labels and live-deployment safeguards.

See [AWS read-only bootstrap](docs/aws-readonly-bootstrap.md) for the isolated OIDC role, one-time manual setup and sanitized Connect inventory. The workflow cannot deploy resources or inspect phone numbers.

## Decision Proof wording

StockGuard produces a **cryptographically signed, machine-verifiable decision record with tamper-evident audit chaining**.

The proof verifies the integrity and signer origin of the StockGuard record. It does not prove that a supplier or manager statement is true, provide strong identity verification, or constitute a legal signature or non-repudiation mechanism.
