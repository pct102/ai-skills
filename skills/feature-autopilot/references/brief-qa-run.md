# QA brief, part 2: run the suite against the finished build

The builder says it is done. Run what you wrote and report; do not edit product code.

0. Run the suite with the `qa-evidence` command from `acceptance.yaml` as written. It writes `.sdlc/features/<f>/evidence/playwright.json`
   (and `PLAYWRIGHT_HTML_OPEN=never` keeps a failing run from stopping to serve the HTML report). Do not change the redirect or the reporters.
   Keep the default `playwright-report/` folder name in your playwright config: the ship tool only skips that exact name,
   and the HTML report is local-only — never stage or commit `playwright-report/` or `test-results/`.
1. Run the fast tier first: `<fast command>` (`--max-failures=3`). Then the full suite once, including `@slow`.
2. For every failure, work out whether the product or your test is wrong. If it is not obvious, one cheap second opinion:
   `bash "$AI_SKILLS_HOME/tools/jev-check.sh" <f> "Product defect, test defect, or environment?" "<expected vs actual>" product="product code is wrong" test="the test is wrong" env="flake, port, data or setup"`
   (a hint only; `JEV UNAVAILABLE` means decide yourself). Fix your own test bugs in `e2e/<f>/`
   and rerun. Do not weaken an assertion to make it pass.
3. Reply with this table, then the defect list:

| behaviour | pass/fail | screenshot | note |
| --- | --- | --- | --- |

Each product defect: repro steps, expected, actual, screenshot path. Do not guess at the cause in code.

4. File each product defect (not your own test bugs) in the issue tracker, if one is set up. Which tracker (GitHub or
   Jira) is decided by this project's own `.sdlc/autopilot.env`, so run the command from the project root and never
   pick a tracker yourself. Write the defect
   (repro steps, expected, actual, screenshot path) to a file, then run:
   `node "$AI_SKILLS_HOME/tools/sdlc-issue.mjs" create --feature <f> --title "<short defect title>" --body-file <file>`
   It reuses an open issue with the same title, so a rerun never files a duplicate. If it says the tracker is
   off, carry on and keep the defect in your reply. Add the printed issue id or link to the defect's `note`.
   Never paste tokens or credentials into an issue. File nothing for a defect you could not reproduce.

End with one line: `QA RESULT: PASS` if every behaviour passed, otherwise `QA RESULT: FAIL <count>`.
