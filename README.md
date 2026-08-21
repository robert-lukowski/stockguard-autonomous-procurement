# StockGuard

Autonomous multilingual procurement with independently validated, policy-bounded execution.

StockGuard predicts an inventory shortage, uses CALL-E to collect comparable offers from approved suppliers in their preferred languages, validates the original-language evidence against deterministic procurement policy, and creates a synthetic purchase order when every control passes.

## Current foundation

This branch contains the React 19 product dashboard with a fully synthetic scenario:

- one predicted CF-220 stockout;
- three approved suppliers in Germany, France, and Poland;
- normalized multilingual offers;
- an independent validation result;
- a machine-enforced policy proof;
- a synthetic purchase order;
- an operator kill switch.

No real calls, purchases, suppliers, organizations, or production data are used.

## Run locally

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run lint
npm run build
```

## Safety boundary

The current implementation is UI-only. CALL-E and AWS integrations will be added behind mockable adapters. Real telephone calls and paid infrastructure remain disabled until explicitly authorized.
