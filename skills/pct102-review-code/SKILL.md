---
name: pct102-review-code
description: Reviews a feature or bug-fix diff using the review discipline from obra/superpowers and mattpocock/skills. Use before merge or release; prefer the installed requesting-code-review or code-review skill when available.
---

# Personal Review Adapter

Use the installed `requesting-code-review` skill from `obra/superpowers` or `code-review` from `mattpocock/skills` first. If unavailable, review:

- requirement and acceptance compliance
- correctness and edge cases
- API and data contract changes
- security and privacy — run `node ${AI_SKILLS_HOME}/tools/security-scan.mjs . --severity high` and
  review the checklist in `skills/security-audit/SKILL.md`: SQLi/RLS, hardcoded secrets, client-side
  auth, IDOR, XSS, storage buckets, security headers, CORS, SSRF, sensitive logging
- accessibility and user-facing behavior
- performance and reliability
- test coverage and validation evidence
- scope creep and unnecessary dependencies

Use the upstream separation when available: review the standards axis separately from the originating spec axis so one concern does not hide the other. Report findings with a concrete location, impact, and remedy.

Do not approve a change solely because the diff is small, the tests are green, or the author reports success. A passing test suite does not replace the feature contract or runtime evidence.

Use Jev to rank findings by explicit severity criteria when there are several findings. Jev does not replace the review evidence or a human decision for a blocker.
