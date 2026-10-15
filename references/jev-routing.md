# Jev Routing Reference

Use Jev before a human-facing question only when the next action is a bounded decision.

## Supported judgments

- `noul`: Does this unresolved branch block the next step?
- `choice`: Which of the explicitly defined options should be presented?
- `score`: How urgent or severe is this evidence according to the declared levels?
- `classify`: Which defined class best describes a log, finding, or candidate root cause?

## Alignment flow

1. Gather raw repository context.
2. Identify unresolved decision branches.
3. Send only explicit branches and criteria to `pct102-jev`.
4. Use a high-confidence automatic result to choose the next question path.
5. Ask the user the actual product question.
6. Record the answer in the owning intent or spec artifact.

Jev must not answer product intent, approve a production action, invent a requirement, or replace a deterministic test. A `review` or uncertain result requires local reasoning or a human decision.

## Proxy configuration

Use the local adapter variables when the Jev MCP is not directly configured:

```text
JEV_ENDPOINT=http://127.0.0.1:8765/v1/systemone
JEV_PROVIDER=custom
JEV_API_KEY=local-proxy
```

Never print or commit provider secrets. If the local proxy is unavailable, continue with the explicit fallback in the owning skill rather than blocking ordinary work.
