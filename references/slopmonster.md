# SlopMonster Reference

Source: `https://github.com/ItsssssJack/SlopMonster`

## Use

Use this reference for user-facing English copy: landing pages, README, documentation, emails, UX copy, and marketing pages. It is a content-quality gate, not a code review tool.

## Workflow

1. Score the draft with the repository's `deslop.py` rules.
2. Identify AI vocabulary, sentence shapes, punctuation cadence, rule-of-three rhythm, and unsupported proof.
3. Rewrite for specificity, plain language, and real user value.
4. Optionally run `cleanse.sh` with a different model family.
5. Re-score the result.
6. Perform a human review for meaning, facts, voice, and domain correctness.

## Guardrails

The scorer is English-only; non-English content requires a different or human review. Never invent customer counts, testimonials, ratings, performance claims, or security guarantees. A score of 5 does not prove factual accuracy or good UX. Keep the original claim source with every number.
