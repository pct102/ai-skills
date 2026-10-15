# Structuring a web feature so builders can work in parallel

Parallel builders need files they can own separately. The shape depends on the project, not on the kind of
feature. Decide it while writing `plan.md`, before any builder starts.

| Project | Split by | Notes |
| --- | --- | --- |
| Plain HTML/JS, no build step | several `js/*.js` files loaded by classic `<script>` tags, one shared namespace (`window.App = window.App || {}`) | Works from `file://`. No `import` (modules need a server). `index.html` only loads the scripts, in dependency order; the wiring slice owns it. |
| Framework or bundler (React, Vue, Svelte, Next...) | module: component or page, store/state, service or API client, styles | One slice per folder. Shared types or contracts go in the first slice others depend on. |
| Backend or API | layer: route/handler, service, data/model, migrations | Route signatures and payload shapes are fixed in the plan. |
| Small feature (a few files, one concern) | do not split | One builder, no `slices.json`. Splitting costs more than it saves. |

## Rules

1. **Disjoint files.** Two slices that can run together never own the same file or folder. `sdlc-slices plan` refuses otherwise.
2. **Interfaces first.** `plan.md` has an "Interfaces" section: every name, signature, event and data shape that crosses a
   slice boundary, written before the builders start. Builders cannot see each other's code, so this is the only coupling.
3. **Pure core, thin shell.** Put logic that needs no browser or server (rules, calculations, parsing) in its own slice. It can be
   tested in milliseconds without a browser, which is where most of the time is saved.
4. **One wiring slice.** The file that joins the parts (entry script, `index.html`, router, app module) belongs to a last slice that
   depends on the others. No parallel builder edits it.
5. **Split only when worth it.** At least three separable parts, each about ten minutes of work or more. Otherwise keep one builder.
6. **Shared files** (`package.json`, lockfile, config) are written by the leader before the slices start, or by the wiring slice.

## Plain HTML/JS without a build: the concrete shape

```
index.html          only loads the scripts, in order; no logic
css/style.css
js/
  namespace.js      window.App = window.App || {}   (loaded first)
  state.js          App.state = { ... }             pure data, no DOM
  rules.js          App.rules = { ... }             pure functions, testable without a browser
  view.js           App.view = { ... }              the only file that touches the DOM
  input.js          App.input = { ... }             events -> calls into rules/state/view
  main.js           App.init = function () { ... }; App.init()   (loaded last, the wiring slice)
```

```html
<script src="js/namespace.js"></script>
<script src="js/state.js"></script>
<script src="js/rules.js"></script>
<script src="js/view.js"></script>
<script src="js/input.js"></script>
<script src="js/main.js"></script>
```

- Each file adds exactly one property to `App` and reads the others only inside functions (never at load time), so the order
  only has to put `namespace.js` first and `main.js` last.
- Classic `<script>` tags, not `type="module"`: modules are blocked on `file://`, and these apps are opened by double-click.
- Pure files (`rules.js`, `state.js`) are testable with plain Node by loading them into a `vm` context or `globalThis`,
  which is far faster than a browser. Keep logic there and keep `view.js` thin.

## Refactoring an existing single file into modules

Ask for it as its own autopilot feature, with the rule "no behaviour change":

- The existing tests (or, if none, a QA suite written first from the current behaviour) must pass before and after, unchanged.
- Slice by the layers above; `main.js` and `index.html` form the last, wiring slice.
- Interfaces (the `App.*` names and function signatures) are written into `plan.md` first, taken from the existing code.
- Nothing is added, renamed on screen, or fixed on the way. Bugs found are listed in the report, not fixed.
