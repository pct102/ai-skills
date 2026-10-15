# Test contract: <feature>

Written by the leader before anything is built. It is the only thing QA sees besides `spec.md`: QA writes the
end-to-end suite from it while the builder builds, without reading the source. The builder receives it too,
so the hooks below exist when QA's tests run.

Describe what a user (or API client) can observe. Never describe how it is implemented.

## How to open the thing under test

How QA reaches it: URL or file path, start command if any, test data or seed it may rely on.

## Stable hooks

Names the builder must put in the UI and QA may rely on. Prefer `data-testid` for web UI; for an API, the
route and the response fields.

| hook | what it is |
| --- | --- |
| `data-testid="login-submit"` | the button that submits the login form |

## Behaviours

One row per observable behaviour. QA writes at least one test per row, a screenshot per visible state, and
the main failure paths that apply.

| id | given | when | then (observable) | tier |
| --- | --- | --- | --- | --- |
| B1 | a user with valid credentials | submits the form | lands on the dashboard and sees their name | fast |
| B2 | a wrong password | submits the form | stays on the form and sees an error, no redirect | fast |
| B3 | 300 random inputs | each is processed | none leaves the screen in an invalid state | slow |

`tier`: `fast` runs on every round (a few seconds each). `slow` (many iterations, long waits, big data) runs only
in the final verify, never in the builder's loop.

## Out of scope

What QA must not assert, so a good implementation is not failed for a detail the spec leaves open.
