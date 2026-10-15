# Public APIs Reference

Source: `https://github.com/public-apis/public-apis`

## Use

Use this catalog when a feature needs an external data source and no provider has been chosen. Search by domain, then verify the provider's official documentation before implementation.

## Workflow

1. Define the data needed, freshness, geography, and quality bar.
2. Search the catalog for two or three candidates.
3. Verify official documentation, authentication, pricing, rate limits, CORS, terms, privacy, and status pages.
4. Test a small read-only request.
5. Rank candidates by fit, reliability, cost, privacy, and fallback quality.
6. Record the chosen provider, version assumptions, quotas, and failure behavior in the feature evidence.

## Guardrails

- The catalog is a lead list, not an endorsement or source of truth.
- “Free” may still require an API key, registration, or rate limits.
- Check whether data is suitable for production, caching, redistribution, and model training.
- Add retry, timeout, caching, quota, and provider-failure behavior.
- Never expose provider secrets in client code or logs.
- Use Jev to rank candidates only after the criteria and evidence are explicit.
