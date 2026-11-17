---
name: pct102-lead-spec
description: Writes the spec for one big GitHub issue (a feature, an enhancement, a bug with no known cause, or one MUGA lesson's 10–15 question generators) before a cheap agent such as dsh-superagent implements it. For a lesson it picks the real words, the confusions used as distractors, the reading passage, the generator list and the cognitive-level matrix, re-solves sample answers, and makes and checks the pictures. Posts the result on the issue and sets spec-ready. Use when the user gives an issue URL labelled needs-spec or asks to "spec", "lead-spec" or "chuẩn bị" an issue; not for small fixes (they go straight to the agent), not for writing the code, and not for teacher lessons or exams (pct102-lesson, pct102-exam).
---

# Lead spec

The agent that implements runs on a free text-only model. It codes well when every judgment is already made, and it makes things up when it has to choose: it invented "huôc" and "suôi" for #227 and kept them through five QA rounds. This skill makes those judgments with a strong model, once, and writes them where the agent will read them. It never writes the generator or feature code.

## Input

- An issue URL. The repository's local clone (MUGA: `/Users/phanchitrung/MUGA/muga`) for reading code and running checks.
- Run only on issues the owner labelled `needs-spec`. If the label is missing, ask whether the issue is big enough; a small fix needs no spec.

## Who decides what (do not let two skills decide one thing)

| Decision | Owner |
| --- | --- |
| Content: real words, confusions, passage, matrix, sample questions, pictures | this skill |
| Which base generator type, reuse or new (Steps 1–2 of the repo's `generator-create`) | this skill, written into the spec |
| Code, registration, tags, running the validator (Steps 3–5 of `generator-create`) | the implementing agent |
| Right or wrong | the repo's validator (`npm run validate:generator`) and QA |
| Teacher lesson HTML, exam papers | `pct102-lesson`, `pct102-exam`: never call them from here |

## 1. Read before writing

1. The issue, every comment, and the issues it links or is blocked by: `gh issue view <n> --repo <repo> --comments`.
2. The repo's rules: `AGENTS.md`, `.muga/lessons/INDEX.md`. Grep the lessons for words from the issue (`grep -i "fill\|ảnh\|distractor" .muga/lessons/*.md`) and copy every relevant ID into the spec.
3. For a lesson: `docs/VIETNAMESE-G1-ACTIVITY-PACK.md` (key list §1, bank size §2, fill rules §3a/§3b, reference files §10), the lesson's notes in `docs/lessonData/grade1/vietnamese-TAP1-NOTES.md` or `TAP2-NOTES.md`, and the textbook PDF pages for that lesson (use `markitdown`; read only, never copy text, D-V6).
4. `generator-create` Steps 1–2 in `.agents/skills/generator-create/SKILL.md`: decide reuse or new and record why.

## 2. Size the spec to the issue

| Issue | Write |
| --- | --- |
| Enhancement of one area | One comment: goal, done-when list, rules and reference files that apply. No files. |
| Feature, unknown-cause bug | `spec.md` and `plan.md` in `.sdlc/features/<date>-<topic>/`, following `AGENTS.md` §4 (Evidence table, `New in this spec`, `npm run spec:verify`). |
| One lesson (MUGA) | `spec.md` from `references/lesson-template.md`, in `.sdlc/features/<date>-tv1-bai-<n>/`, plus pictures. No `plan.md`: the template's generator table is the plan. |

Get the date from `date +%F`, not from memory.

## 3. A lesson: decide the content

Fill every section of `references/lesson-template.md`. The parts the cheap model gets wrong are the reason this skill exists, so do them carefully:

- **Words.** For each vần, 6–12 real words a six-year-old knows, each with a short meaning hint (the hint is what fill questions show, never the word). Check every word with the repo's dictionary; a word that fails is replaced, not added to the extra list unless it is a real word the dictionary lacks (say why):
  ```bash
  node -e 'const fs=require("fs");const set=new Set(["vi-syllables.txt","vi-syllables-extra.txt"].flatMap(f=>fs.readFileSync("src/scripts/data/"+f,"utf8").split("\n").map(l=>l.replace(/#.*/,"").trim().normalize("NFC").toLowerCase())));const bad=process.argv.slice(1).flatMap(w=>w.normalize("NFC").toLowerCase().split(/\s+/)).filter(s=>!set.has(s));console.log(bad.length?"NOT FOUND: "+bad.join(", "):"all real")' -- "luộc rau" "buộc dây"
  ```
  The dictionary places tones old-style (hoá); the validator accepts the modern style the repo uses (hóa), so a modern-style miss is fine.
- **Confusions.** The mistakes children really make with these vần (uôc/uôt, ươi/ươu, a wrong tone, a missing letter). Distractors come only from this list.
- **Passage.** 6–10 short real sentences using the lesson's words, written in your own words. They are copied verbatim into the code, so they must be final.
- **Generators.** 10–15 keys: the 7 required for the lesson type (§1) plus optional ones that fit. For each: key, factory, what it asks, bank items (at least 10), which rule IDs apply.
- **Matrix** (from `pct102-exam`). Each key gets a cognitive level: Nhận biết, Thông hiểu or Vận dụng. A lesson needs at least two keys at Thông hiểu or above.
- **Samples.** 10 sample questions across the keys, each with its answer. Then **re-solve each from the question alone, without looking at your answer**, and fix any mismatch. Wrong keys are the main failure of model-written questions.

## 4. Pictures (only if the lesson has `_IMAGE_PICK`)

1. Pick words that can be drawn unambiguously (a thing or an animal, not "ngoan" or "buộc"). One file per word, named `bai<n>-<ascii-slug>.jpg`.
2. Write `subjects.json` as `{"bai67-luoc-rau": "boiled green vegetables in a pot"}`: describe the thing in English, never the Vietnamese word.
3. In the repo: `node scripts/gen-viet-g1-images.js --subjects <path>/subjects.json` (Cloudflare Workers AI; keys from `.env.development.local`, never print them).
4. **Look at every image** with the Read tool. If it does not clearly show the word, rewrite the subject and regenerate (`--only <slug>`), up to 3 times; then drop the word.
5. Add each accepted picture to `public/images/viet-g1/words.json` as `"bai67-luoc-rau.jpg": "luộc rau"`. The validator fails any option whose picture is recorded as another word.

## 5. Publish

1. Branch from the latest `origin/dev`: `spec/issue-<n>`. Commit the spec directory, any pictures and `words.json`. Run `npm run spec:verify <spec.md>` for a feature spec; for a lesson, run the word check above on the final word list. Push and open a PR into `dev`. When its CI is green, merge it with `gh pr merge <pr> --rebase --delete-branch`, so the agent starts from a `dev` that has the spec and pictures.
2. Comment on the issue in Vietnamese. Start with the PR link and the spec path. Then add one `<details>` section per part: words, confusions, passage, generators and matrix, samples, pictures (a table of word and file), and the rule IDs that apply. End with what "done" means, in checkable terms, including `npm run validate:generator -- --lesson <n>` exit 0.
3. Labels: `gh issue edit <n> --add-label spec-ready --remove-label needs-spec`.
4. Tell the owner the spec is ready and which accounts to tag. Do not tag the agent yourself; the owner decides who builds and who verifies.

## Done when

- [ ] Every word in the spec passes the dictionary check, or is in `vi-syllables-extra.txt` with a reason.
- [ ] 10–15 keys, each with at least 10 bank items, and a cognitive level for each.
- [ ] 10 samples re-solved blind, with no mismatch left.
- [ ] Every picture was looked at and recorded in `words.json`.
- [ ] Spec PR merged into `dev`; issue comment posted; `spec-ready` set.
