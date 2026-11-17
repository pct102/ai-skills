# Anatomy Reference

Source: `https://github.com/wheresryan22/anatomy` (MIT)

## Use

Explains one idea as a real, working isometric object (cache key → pin-tumbler lock) in standalone interactive HTML: SVG, optional WebGL, optional 3D. Needs Node 20.10+ and Chrome or Chromium; no API keys.

Not a replacement for `archify`: `archify` draws accurate system diagrams; anatomy draws an explanatory metaphor. If the reader needs the real components and flows, use `archify`.

## Install

```bash
npx skills add wheresryan22/anatomy -g -a claude-code
```

Run `references/skillspector.md` first. Invoke with `/anatomy <idea>, interactive`.

## Cost warning

The skill sizes its own work: a Figure is 40-80 parts, a Hero 80-150 parts and about 2-4 hours. Always say which size you want.

## Rules

- Call it only when the user asks for an explainer illustration. Never from autopilot, QA loops, or as a default for "make a diagram".
- Ask for Figure size unless the user wants more.
- The result is a file; publish it as an Artifact only if the user asks to share it.

## Cases

- **Lesson or tutorial hero image:** `/anatomy explain how <concept> works, interactive`. Pair with the lesson text so the figure carries one idea.
- **Report or doc explainer:** one Figure per key mechanism, not per section.
- **Accurate architecture:** `archify`, not anatomy.
