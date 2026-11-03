# Integration notes

- **React:** `<button aria-expanded={open} aria-label={t('menu')} onClick={() => setOpen(!open)}><svg className="mi mi-menu" viewBox="0 0 24 24" aria-hidden="true">...</svg></button>`. No extra state for the animation.
- **Tailwind / shadcn:** keep `morph.css` as plain CSS (imported in the root layout). On shadcn `Button variant="ghost" size="icon"`, put the SVG inside and leave Button's focus styles alone.
- **Icon libraries (lucide, heroicons):** wrap their `<svg>` with `className="mi mi-chev"` etc. Solid single-path icons only support whole-icon motion (rotate, pop, nudge).
- **next-intl / RTL:** `mi-nudge` moves right; flip with `[dir=rtl] .mi-nudge { transform: scaleX(-1) }` if needed.
- **Gotchas:** the stylesheet sets `transform-box: fill-box` so each part rotates around its own centre (without it the bars pivot around the SVG corner). Do not set `overflow: hidden` on the SVG: the heart pop and the bell swing leave the 24px box. Keep `stroke="currentColor"` so dark mode and hover colours follow the button's text colour.
