# Quality Gates

Use the project's declared commands. If none are declared, inspect the repository and propose the smallest validation set before editing.

Encode the applicable gates as checks in the feature's `acceptance.yaml` and run them through `${AI_SKILLS_HOME}/tools/sdlc-verify.mjs`. Do not run them by hand and record the outcome in prose.

## Standard gate order

1. Focused test
2. Related test suite
3. Lint and formatting
4. Typecheck or compile check
5. Build
6. Security and dependency checks — `npm audit` for CVEs, plus
   `node ${AI_SKILLS_HOME}/tools/security-scan.mjs . --severity high` for the vulnerability classes
   AI code most often produces (SQLi, RLS, secrets, XSS, auth, storage, headers). See
   `skills/security-audit/SKILL.md` for the full checklist. Required when the feature touches
   auth, database, storage, payments, or user-generated content.
7. Runtime or E2E verification
8. Diff and acceptance review

## Status vocabulary

- `pass`: command exited as `acceptance.yaml` expects. Only `sdlc-verify` may record this, in `evidence.json`.
- `fail`: command produced a real product or code failure
- `flaky`: repeated runs disagree
- `environmental`: infrastructure, credential, network, or service availability prevented the check
- `not-applicable`: the check does not exist or does not apply to the changed boundary. Record this by deleting the check from `acceptance.yaml`, never by writing a command that trivially succeeds.
- `manual`: only a human can confirm it. Represent it as a `kind: manual` check and record the approval with `--approve <check-id> --by <name>`.

## Loop rule

A failed deterministic check blocks completion. A flaky or environmental failure remains visible and cannot be silently reclassified as pass.

`status.json` counts consecutive failed validations against the feature's `budget`. When the budget is spent the phase becomes `escalated` on its own, and an escalated lane does not recover by re-running. Only an explicit triage decision (`--reset-repair`) returns it to `validating`. Exhaustion is an escalation, not a success.

## Human approval gates

Require explicit approval for production deployment, destructive data operations, credential or billing changes, public contract changes, and broad architecture changes. Each one is a `kind: manual` check so that acceptance is blocked until the approval exists in `status.json`.
