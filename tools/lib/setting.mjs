// setting(NAME) -> value from the environment, then ./.sdlc/autopilot.env, then <ai-skills>/autopilot.env ('' if unset).
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const setting = (k) => {
  if (process.env[k]) return process.env[k]
  for (const f of ['.sdlc/autopilot.env', join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'autopilot.env')]) {
    if (!existsSync(f)) continue
    const m = [...readFileSync(f, 'utf8').matchAll(new RegExp(`^\\s*${k}\\s*=\\s*(.*)$`, 'gm'))].pop()
    const v = m && m[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '')
    if (v) return v
  }
  return ''
}
