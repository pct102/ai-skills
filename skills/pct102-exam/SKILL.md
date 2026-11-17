---
name: pct102-exam
description: Writes a school exam (đề kiểm tra, đề thi) from a blueprint: ma trận đề by topic and cognitive level, multiple-choice, short-answer and essay questions, answer key, grading rubric, then checks it with a script (points add up, matrix matches, level ratios, answer-letter spread, option lengths) and exports Word or PDF. Use when a teacher wants an exam, quiz, or test paper for a class; not for a lesson (pct102-lesson), adaptive practice, or MUGA question generators (use pct102-lead-spec).
---

# Exam

A teacher's exam is only as good as its blueprint and its answer key. The model writes questions; `scripts/examcheck.mjs` decides whether the paper is acceptable. Do not call an exam finished before the script prints `EXAM: PASS`.

All files live in the teacher's working folder, not in this skill. Copy `templates/exam.example.json` there as `exam.json` and edit it.

## 1. Intake (ask, do not guess)

Ask once, in one message, and wait:

- Subject, grade, and the unit(s) or lessons covered. Ask for the source material (textbook pages, lesson notes, the curriculum standard). Use `markitdown` to read a PDF or Word file.
- Duration, total points (default 10), and the question mix: multiple choice, short answer, essay.
- Cognitive levels and target shares. Propose the common four-level scale (Nhận biết 40%, Thông hiểu 30%, Vận dụng 20%, Vận dụng cao 10%) as a starting point and ask the teacher to confirm or change it to match their school's or ministry's rules. Do not claim a regulation says so.
- Language of the paper (default Vietnamese).

Never invent curriculum content. If no source material is given, say so and write only what the stated unit certainly contains, marking anything uncertain for the teacher to check.

## 2. Blueprint first (ma trận đề)

Fill `meta`, `levels`, `targets`, and `matrix` in `exam.json` before writing any question. Each matrix row is `topic × level → number of items, points`. Show the table to the teacher and get approval. Changing the blueprint later means re-running the check.

## 3. Write the items

For each matrix cell, write exactly that many items into `items`.

- `mcq`: `stem`, `options` (exactly `meta.options`, default 4), `answer` (a letter), `explanation`. One clearly best answer; distractors are plausible mistakes a student really makes. No "all of the above"; no "none of the above".
- `short`: `stem`, `answer_text`.
- `essay`: `stem`, `answer_text` (a model solution), `rubric` (criteria whose points add up to the item's points; split the points by step, so partial credit is decided in advance).
- Options in one question should be about the same length and form, so the right one cannot be spotted by shape. Spread the correct letter across the paper.
- Math and science: write plain Unicode (x², √2, ½, ≤). The Word and PDF skills do not render LaTeX; say so if the teacher needs typeset formulas.

## 4. Verify the key independently

Before running the script, solve every item again from the stem alone, without looking at the key, and compare. Fix every mismatch. Model-written answer keys are the main failure of this workflow, so this step is not optional. Tell the teacher which items you re-solved.

## 5. Run the gate

```bash
node <skill>/scripts/examcheck.mjs check exam.json
```

It checks: structure, total points, matrix match, level shares against `targets` (±`tolerance`), MCQ validity, essay rubric sums, answer-letter spread (needs 8+ MCQ), option length ratio, and duplicate stems. Fix every `FAIL` and rerun. A `WARN` is reported to the teacher and does not block. Never edit `exam.json` to silence a check without changing the exam itself.

## 6. Export

```bash
node <skill>/scripts/examcheck.mjs render exam.json out/
```

This refuses to write while any `FAIL` remains and creates `de-thi.md` (paper, no answers), `dap-an.md` (key, explanations, rubrics), and `ma-tran.md` (blueprint table).

Then make the files the teacher asked for:

- Word: `NODE_PATH=<dir>/node_modules node <skill>/scripts/exam2docx.mjs exam.json out/` writes `de-thi.docx`, `dap-an.docx`, `ma-tran.docx` (A4, Times New Roman 13pt, answer space under each essay question). It needs the `docx` npm package: `npm install docx` in any scratch folder, then point `NODE_PATH` at its `node_modules`. If it fails or the teacher wants a layout the script does not give, use the installed `docx` skill on the three Markdown files instead.
- PDF: use the installed `pdf` skill on the Markdown, or print the Word file.

Open the result and look at it once (page breaks, tables) before telling the teacher it is done. Keep `de-thi` and `dap-an` as separate files; never put the key in the student's file.

## What this skill does not do

Shuffled versions (mã đề), adaptive difficulty, automatic marking of scanned answer sheets, and item statistics after the exam are not included. Say so when asked.

## Checks of the checker

```bash
node --test <skill>/scripts/examcheck.test.mjs
```
