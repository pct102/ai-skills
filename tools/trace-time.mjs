// trace-time.mjs — one way to print a recorded time, shared by sdlc-trace and sdlc-diagrams.
// Events are stored as UTC ISO strings. They are shown in the machine's local time, with the year and
// the month spelled out, so "2026 October 3" can never be read as 3 October or 10 March.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const p2 = (n) => String(n).padStart(2, '0')

export const dayOf = (iso) => { const d = new Date(iso); return `${d.getFullYear()} ${MONTHS[d.getMonth()]} ${d.getDate()}` }
export const clockOf = (iso, seconds = false) => {
  const d = new Date(iso)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}${seconds ? ':' + p2(d.getSeconds()) : ''}`
}
// "2026 October 3 14:04:52"
export const stamp = (iso, seconds = false) => `${dayOf(iso)} ${clockOf(iso, seconds)}`
// "2026 October 3 10:00 to 10:29" on one day, both dates in full when it crosses midnight
export const range = (a, b) => (dayOf(a) === dayOf(b) ? `${stamp(a)} to ${clockOf(b)}` : `${stamp(a)} to ${stamp(b)}`)
