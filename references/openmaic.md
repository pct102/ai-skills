# OpenMAIC Reference

Source: `https://github.com/THU-MAIC/OpenMAIC` (MIT)

## Use

Open Multi-Agent Interactive Classroom: turns a topic or documents into an interactive course (slides, quizzes, interactive HTML simulations, project-based learning, whiteboard, narration). Exports `.pptx`, one offline `.html`, or a classroom ZIP. Its agent workbench builds and edits courses through chat and has 24 built-in teaching skills.

It is an application (Next.js 16, Node 22.19+, pnpm, PostgreSQL), not a skill. It stays outside this repo as a service.

## Three ways to use it

| Mode | When | Privacy |
| --- | --- | --- |
| Live demo `https://open.maic.chat` (access code) | Trying it; one-off classroom | Topic and uploaded documents go to a third-party server. Never upload confidential material. |
| Local: `git clone`, `docker compose up --build`, open `http://localhost:3000` | Regular use; own model keys | Stays on the machine. Set models in `openmaic.yml`, keys in env files edited by the user. |
| Build on it (`@openmaic/*` SDK) | Embedding generation in another product | Own code; follow its docs. |

## Agent skill

The repo ships an OpenClaw-format skill at `skills/openmaic/` (guided setup and generation SOP, confirmation-heavy) and `skills/classroom/`. Installing it into Claude Code is a plain copy of that folder to `~/.claude/skills/openmaic`; not tested here. Scan it first (`references/skillspector.md`). Never paste provider keys into chat.

## Rules

- Do not copy OpenMAIC code into this repo.
- Courses live in its PostgreSQL volume; back that up if the courses matter.
- Quiz is a scene type inside a lesson. It is not an exam builder: for an exam (blueprint, point scale, answer key, rubric) write the content here and use OpenMAIC only for the teaching side.
- Generated slides and quizzes are model output; check facts against the source documents before use.

## Cases

- **Lesson from a PDF or topic:** convert with `markitdown` if needed, run local OpenMAIC, review, export `.pptx` or offline HTML.
- **Explainer inside a lesson:** add an `anatomy` figure (`references/anatomy.md`) for one key mechanism.
- **Exam:** draft in this repo's own workflow; do not rely on OpenMAIC quiz scenes alone.
