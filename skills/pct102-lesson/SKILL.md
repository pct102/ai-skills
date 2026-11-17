---
name: pct102-lesson
description: Builds a classroom lesson for students (bài giảng, giáo án, phiếu học tập) as one printable HTML file with a student sheet and a teacher frame, using the `teach` skill's lesson structure (mission, one tight objective, retrieval-practice quiz, glossary, sources). Use when a teacher wants a lesson or worksheet for a class on a given topic; not for an exam (pct102-exam), not for the user's own self-study (use `teach` directly), and not for MUGA question generators or a MUGA "bài" issue (use pct102-lead-spec).
---

# Lesson (teacher edition of `teach`)

This is a thin layer. The lesson design, file formats, and teaching rules belong to Matt Pocock's `teach` skill (`mattpocock/skills`). Do not re-implement them here.

## Before anything

Read, in full: `~/.claude/skills/teach/SKILL.md` and its four format files (`MISSION-FORMAT.md`, `RESOURCES-FORMAT.md`, `LEARNING-RECORD-FORMAT.md`, `GLOSSARY-FORMAT.md`). If they are missing, stop and tell the user to install them (`npx skills add mattpocock/skills --skill teach`). Do not improvise a replacement.

`teach` is manual-only, so you read and follow its files; you do not call it as a skill.

## What changes for a classroom

| `teach` says | In a classroom |
| --- | --- |
| The learner is the user | The learners are the students; the user is the teacher. Ask the teacher for grade, class size, period length, and what students already know. |
| `MISSION.md` = why the user wants this | `MISSION.md` = the unit's objective for the class: observable verbs ("calculate", "explain", "compare"), the curriculum standard if the teacher gives one, constraints (time, devices, no internet), and what is out of scope. |
| Learning records track one person | Record **class-level** facts: misconceptions students usually have, prior knowledge confirmed by the teacher. Individual progress only if the teacher teaches one student. |
| Lesson is for the user to read | One lesson = one period, one objective, one tangible win. Two views in the same file: student sheet and teacher frame (below). |
| Never trust parametric knowledge | Same. Ground every fact in the textbook the teacher provides or in a trusted source listed in `RESOURCES.md`, and cite it. |
| Wisdom from a community | Replace with a real-world task or a short discussion the class can do. |

Keep `teach`'s quiz rule: all answer choices the same number of words and characters.

## Files

In the teaching workspace (the current folder), copy `<skill>/assets/lesson.css` to `./assets/lesson.css` once; every lesson links it. Lessons go in `./lessons/0001-slug.html` as in `teach`.

## Lesson file structure

```html
<link rel="stylesheet" href="../assets/lesson.css">
<body>
<button class="toggle no-print" onclick="document.body.classList.toggle('student')">Xem bản học sinh / giáo viên</button>

<header> title, class, date, duration, objective in one sentence </header>

<!-- STUDENT SHEET: what is printed for the class -->
<main class="student-sheet"> knowledge (short), worked example, practice with answer space,
  retrieval quiz, exit ticket, source to read </main>

<!-- TEACHER FRAME: hidden in student view and in print-student -->
<aside class="teacher-only">
  objective and standard · prep and materials · timed plan (minutes per step) ·
  expected answers for every task · common misconceptions and what to say ·
  differentiation (struggling / ahead) · how to check understanding · homework
</aside>
</body>
```

Rules:

- Student sheet must make sense with the teacher frame removed. Never put answers or hints that give answers in the student sheet.
- The teacher frame must contain the full answer key for every task and quiz item in the sheet, so the teacher can grade without opening anything else.
- Time plan adds up to the period length the teacher gave.
- A4, black-and-white friendly: no information carried by colour alone, no dark backgrounds. Interactive quiz widgets may exist on screen but must degrade to a plain printed question with blank answer lines.
- Write a reference sheet (`./reference/*.html`) only if the unit has terms or formulas students will reuse; add terms to `GLOSSARY.md` as `teach` describes.

## Interactive slide deck (optional, for projecting in class)

A lesson may also ship `slides/<name>.html`: one self-contained file (no network, no libraries) the teacher opens in Chrome and projects. `templates/deck.example.html` (Toán 3, Bài 20) is the reference; copy it and replace the slides.

Engine, reused as is: 16:9 stage scaled to the screen; click, Space, or → to advance and ← to go back; `F` fullscreen; `N` shows the teacher notes for the slide (`data-notes`); a progress bar; `#7-3` in the URL opens slide 7 at step 3. A slide declares `data-steps="N"`; any element with `data-s="k"` (HTML) or `data-sv="k"` (SVG) appears from step k (`data-off="m"` hides it again at step m), and the current step's item gets class `cur`. Animations are plain CSS transitions toggled by that `.on` class, so going back reverses them.

Rules for a deck:

- It carries the lesson's content, not decoration: each slide has one idea, large type (readable from the back of the room), the step the teacher does next, and the answer revealed by a click.
- Use animation where it shows the real procedure (a ê ke sliding onto the corner, a compa turning one full circle, paper folding), and click-to-answer for retrieval practice (quiz buttons with right and wrong feedback). Do not add effects that explain nothing.
- Draw geometry as inline SVG with real coordinates. Never show a "measured" drawing that is not to scale; if a figure is an example and not from the textbook, label it "ví dụ".
- Teacher notes per slide give the minute range from the lesson plan, so the deck and the plan agree.
- Respect `prefers-reduced-motion`. No external fonts or CDN: classrooms often have no internet. Embed the font as base64 `@font-face` (the example embeds Quicksand, the rounded font MUGA uses; its woff2 files are in the MUGA repo under `tests/mainTest/fixtures`, SIL OFL). No emoji as icons: draw small inline SVGs.
- Quiz slides: the illustration is the hero (large card on the left), the question and four big lettered buttons on the right. Hide what gives the answer away (the example shows a "?" and reveals the red corner marks only after a correct click).
- A tool or mechanism (compass) is drawn with layers (shadow, metal legs, pencil, hinge) and moved by a small script that listens to the `stepchange` event; the drawn trail must follow the moving tip.
- Check it before reporting done: screenshot each slide at its final step with headless Chrome (`--screenshot ... "file://.../deck.html#7-4"`), look at them, and watch for text overlapping shapes, labels on top of lines, and answers visible too early. The deck does not replace the printable student sheet.

## Printing

Student copy: `sed 's/<body>/<body class="student">/' lessons/X.html > out/X-hocsinh.html` (keep it beside `assets/` so the stylesheet loads), then
`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer --print-to-pdf=out/X-hocsinh.pdf file://$PWD/out/X-hocsinh.html`.
Teacher copy: same command on the unmodified file (frame starts on its own page). Open the PDFs and check page breaks before reporting done: no prompt separated from its drawing box, nothing cut at the right edge, no teacher text in the student copy.

## Related

- End-of-unit test: `pct102-exam`. Use the same level names so lessons and exam blueprint line up.
- Reading a textbook PDF or Word file: `markitdown`.
- An explanatory illustration: `references/anatomy.md`.
