# Instagram Agent Skill Reference

Source: `https://github.com/Jakeschincariol/instagram-agent-skill` (MIT)

## Use

Thirteen `ig-*` skills for running an Instagram account: `/ig-reel` (scored hooks, beat sheet), `/ig-viral`, `/ig-caption` (linted), `/ig-carousel`, `/ig-story`, `/ig-profile` (100-point rubric), `/ig-plan`, `/ig-human`, `/ig-comment`, `/ig-reply`, `/ig-dm`, `/ig-repurpose`, `/ig-audit`. Five Python scripts run offline with no network and no dependencies (including `hookscore.py`, `beats.py`, `caption.py`, `humanize.py`). The skills write; the user posts. Nothing is published.

## Install (not vendored: 13 skills would bloat every session's skill list)

```bash
git clone https://github.com/Jakeschincariol/instagram-agent-skill.git
cp -r instagram-agent-skill/skills/ig-* ~/.claude/skills/
mkdir -p ~/.claude/instagram && cp instagram-agent-skill/templates/voice.md ~/.claude/instagram/voice.md
```

Or `/plugin marketplace add Jakeschincariol/instagram-agent-skill`, then `/plugin install instagram-agent`. Install only when working on social content; remove when done. Run `references/skillspector.md` first.

Fill `voice.md` once (or give three of the user's own posts and ask for it). Every skill reads it.

## Limits

- Hook formulas and the humanizer's banned-word lists are English-tuned. For Vietnamese copy the scripts' scores are indicative only; a human reads the final text.
- `/ig-viral` research needs data the user supplies or a source such as `references/agent-reach.md`; do not use login channels for it.
- No auto-posting. Do not wire these skills to the Instagram API or a poster.

## Cases

- **One idea to a Reel:** `/ig-reel <idea>`, check with `python3 beats.py script.txt --target 30`.
- **Week plan:** `/ig-plan`, then `/ig-repurpose` on one long video.
- **Strip AI-sounding text from any draft (not only Instagram):** `python3 humanize.py draft.txt --report`.
