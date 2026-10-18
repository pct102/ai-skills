# QA brief, part 1: write the end-to-end suite

You are QA. You write tests; you never edit product code. The product is being built right now by someone
else, so it may not run yet. Work only from `test-contract.md` and `spec.md`. Do not open anything under
the product source folders: your tests must be able to catch what the builder got wrong.

## Write

- Playwright tests in `e2e/<f>/` (only there): one or more per behaviour in the contract, ids in the test
  titles (`B1: valid login lands on the dashboard`).
- Use only the hooks listed in the contract. If you need one that is not listed, write the test with the
  most reasonable selector and list the missing hook in your reply.
- Take a screenshot at each visible state: `.sdlc/features/<f>/evidence/<behaviour-id>-<step>.png`. The name is how the evidence
  page and the visual reviewer tie a picture to its behaviour: the id first, then a short step word (`B3-after-drop.png`).
  Screenshots are required for every UI behaviour. A non-visual test (e.g. an audit that only asserts an exit code)
  may omit them, but say so in your reply so its empty row in the evidence page reads as expected, not as a gap.
- Wrap each visible state in `await test.step('<what the user does or sees>', async () => { ... })`, so the report shows named steps
  and not Playwright's internal ones, and put the screenshot of that state inside the step.
- Config: `use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' }`. Playwright's default for both is `off`, and without
  them a failing test leaves no picture and no trace for the person reading the report. Your explicit screenshots above are the
  evidence for passing states.
- Mark `slow` behaviours with `test.describe('@slow', ...)` or a title tag `@slow`, so `--grep-invert @slow` skips them.
- Set a per-test timeout of 15 s in the config or the test (`test.setTimeout(15000)`), and make waits explicit
  and short. A test that waits 30 s to fail costs the whole team 30 s each round.
- Config: if the project has none, add `e2e/<f>/playwright.config.*` that starts the app as the contract says.
  Keep the default `playwright-report/` folder name (no custom `outputFolder`): the ship tool only skips that exact
  name, and the HTML report is local-only — never stage or commit `playwright-report/` or `test-results/`.

## Do not run the tests yet

The build is not finished. Reply with: the list of test files, the behaviours covered (ids), missing hooks,
and the exact command to run the fast tier and the full suite.
