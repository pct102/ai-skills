# Delivery State Machine

`status.json` is the authoritative state of a feature lane. A skill, a human, or a
subagent may read it freely; only `sdlc-verify` writes it during validation.

The rule this exists to enforce: **`accepted` is granted by a program, never by an
agent deciding it is done.**

## File

`.sdlc/features/<feature-name>/status.json`

```json
{
  "feature": "user-login",
  "phase": "validating",
  "budget": 2,
  "repair_iterations": 1,
  "blocked_reason": "failing_checks: auth-01=1 (iteration 1/2)",
  "approvals": {
    "release-01": { "by": "alice", "at": "2026-01-08T09:14:22.101Z" }
  },
  "last_run": {
    "at": "2026-01-08T09:14:22.101Z",
    "result": "fail",
    "passed": 4,
    "failed": 1,
    "gates_pending": 0
  }
}
```

| field | owner | meaning |
| --- | --- | --- |
| `phase` | `sdlc-verify` | where the lane is; see below |
| `budget` | `acceptance.yaml` | failed validations tolerated before escalation |
| `repair_iterations` | `sdlc-verify` | consecutive failed validations |
| `blocked_reason` | `sdlc-verify` | machine-readable cause, never prose |
| `approvals` | `sdlc-verify --approve` | recorded human gate approvals |
| `last_run` | `sdlc-verify` | summary of the most recent validation |

## Phases

```text
contract ──▶ planned ──▶ building ──▶ validating ──▶ accepted
                 │            │             │
                 │            │             ├──▶ blocked      (human gate pending)
                 └────────────┴─────────────┴──▶ escalated    (repair budget spent)
```

| phase | meaning | who advances it |
| --- | --- | --- |
| `contract` | outcome agreed, acceptance not yet written | `--set-phase planned` |
| `planned` | `acceptance.yaml` written, tasks broken down | `--set-phase building` |
| `building` | implementation in progress | `sdlc-verify` on run |
| `validating` | checks running or a repair is in flight | `sdlc-verify` on run |
| `accepted` | every check passed, no gate pending | `sdlc-verify` only |
| `blocked` | automatic checks pass, a `manual` gate is unapproved | `sdlc-verify` only |
| `escalated` | repair budget spent; needs a human decision | `sdlc-verify` only |

## Legal transitions

```text
contract    -> planned, building, escalated
planned     -> contract, building, escalated
building    -> planned, escalated
validating  -> building, escalated
blocked     -> validating, building, escalated
escalated   -> validating, building
accepted    -> building
```

An illegal `--set-phase` is rejected with exit 3. There is no `--force`, on purpose.

## Repair budget

Each failed validation increments `repair_iterations`. When it exceeds `budget` the
phase becomes `escalated` and `blocked_reason` becomes
`repair_budget_exhausted: <n> failed runs exceed budget <b> (<check>=<exit>, ...)`.

An escalated lane keeps failing if re-run. It does not recover on its own. Only:

```bash
node ${AI_SKILLS_HOME}/tools/sdlc-verify.mjs --feature <name> --reset-repair
```

returns it to `validating` with the counter cleared. That is a triage decision and
belongs to a human. Do not reset it to keep a loop going.

A feature with `budget: 0` escalates on its first failed validation.

## Blocked reasons

| prefix | meaning | who resolves it |
| --- | --- | --- |
| `human_gate_pending:` | a `manual` check has no approval | the user, via `--approve` |
| `repair_budget_exhausted:` | the loop is out of budget | the user, via `--reset-repair` or `bug-fix` |
| `failing_checks:` | checks are failing with budget remaining | the lane, in `building` |

Read the prefix, not the prose after it. Report the check ids verbatim.
