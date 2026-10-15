// setting(NAME) -> value from the environment, then ./.sdlc/autopilot.env, then <ai-skills>/autopilot.env ('' if unset).
// secret(NAME)  -> value from the environment, then <ai-skills>/autopilot.env only. A project file is never read for
//                  credentials: it sits inside the repo an agent works in and could be committed by mistake.
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// AUTOPILOT_GLOBAL_ENV points the global file elsewhere (the selftests use it so they never read your real one).
const GLOBAL = process.env.AUTOPILOT_GLOBAL_ENV || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'autopilot.env')

const fromFiles = (k, files) => {
  for (const f of files) {
    if (!existsSync(f)) continue
    const m = [...readFileSync(f, 'utf8').matchAll(new RegExp(`^[ \\t]*${k}[ \\t]*=[ \\t]*(.*)$`, 'gm'))].pop()
    const v = m && m[1].replace(/(^|\s)#.*$/, '').trim().replace(/^["']|["']$/g, '')
    if (v) return v
  }
  return ''
}

export const setting = (k) => process.env[k] || fromFiles(k, ['.sdlc/autopilot.env', GLOBAL])
export const secret = (k) => process.env[k] || fromFiles(k, [GLOBAL])
