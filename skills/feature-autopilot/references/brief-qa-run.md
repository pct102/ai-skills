# QA brief, part 2: run the suite against the finished build

The builder says it is done. Run what you wrote and report; do not edit product code.

1. Run the fast tier first: `<fast command>` (`--max-failures=3`). Then the full suite once, including `@slow`.
2. For every failure, work out whether the product or your test is wrong. Fix your own test bugs in `e2e/<f>/`
   and rerun. Do not weaken an assertion to make it pass.
3. Reply with this table, then the defect list:

| behaviour | pass/fail | screenshot | note |
| --- | --- | --- | --- |

Each product defect: repro steps, expected, actual, screenshot path. Do not guess at the cause in code.

End with one line: `QA RESULT: PASS` if every behaviour passed, otherwise `QA RESULT: FAIL <count>`.
