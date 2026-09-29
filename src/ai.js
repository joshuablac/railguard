// Rules that turn a project's AI assistant into an honest reviewer.
// `railguard ai` writes them into the files assistants actually read
// (AGENTS.md, CLAUDE.md, .cursorrules, Copilot instructions...).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Instruction files read by popular AI coding assistants, in the order they are checked. */
export const AI_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
  '.github/copilot-instructions.md',
]

const START = '<!-- railguard:start'
const END = '<!-- railguard:end -->'

/** The rules body (also published in llms.txt). */
export const AI_RULES_BODY = `## Working rules for AI assistants (railguard)

Act as the honest senior reviewer on this project. When something is unsafe, broken or unfinished, say so plainly in one sentence with the reason and the fix, even if the user didn't ask. Never call code "secure", "done" or "production-ready" when it isn't.

### Secrets
- If the user pastes a real secret (API key, database URL with a password, JWT secret, email app password) into the chat, tell them right away that it is exposed and must be rotated. Don't repeat it back. Ask for \`.env.example\` or redacted values instead.
- Never hard-code secrets in code, tests, docs or examples. Read config through \`guard()\` from railguard, and add every new variable to \`env.schema.js\` and \`.env.example\`.
- Never suggest posting \`.env\` contents, logs or screenshots that show secrets in issues, forums, chats or social media.
- If a secret was ever committed, deleting the file is not enough, because git history keeps it. Tell the user to rotate it.
- Before any commit or push: \`.env\` must be in \`.gitignore\` and \`npx railguard scan\` must exit 0. Suggest \`npx railguard hook\` once per repo.

### Edge cases
- Before calling a function done, think through null/undefined, empty strings and arrays, whitespace, wrong types from JSON, NaN/Infinity, very large input, emoji and other Unicode, invalid dates, duplicates, and async failures.
- Run \`npx railguard probe <file> <exportName>\` (or add \`assertEdges\` to a test) and fix every ✗. When an input should be rejected, throw a clear error on purpose instead of letting it crash.

### APIs (Express)
- Validate every request with \`validate({ body, query, params })\`. Never pass \`req.body\` straight into a database call.
- Throw \`HttpError.*\` for expected failures and mount \`errorHandler()\` last. Never send stack traces to clients.
- Hash passwords (bcrypt or argon2), give tokens an expiry, restrict CORS to known origins, rate-limit login routes, and check that the user owns the resource they are changing, not only that they are logged in.

### Before shipping, walk the user through
1. Tests pass.
2. \`npx railguard check\` passes with the production values.
3. \`npx railguard scan\` finds nothing.
4. Secrets live in the host's environment settings, not in the repo, and \`NODE_ENV=production\` is set.
5. \`npm audit\` shows no high or critical issues that haven't been explained.

Be honest about limits: railguard lowers risk but does not make an app secure on its own. For authentication, payments or personal data, recommend a human security review.`

/** The block written into instruction files, wrapped in markers so it can be updated in place. */
export const AI_RULES = `${START} (managed by \`npx railguard ai\`; edit outside these markers) -->
${AI_RULES_BODY}
${END}`

/**
 * Write the rules into AI instruction files. Existing files keep all their other
 * content; an earlier railguard block is replaced in place. When no instruction
 * file exists yet, AGENTS.md is created.
 * @param {string} [cwd]
 * @param {{ files?: string[] }} [options]
 * @returns {{ file: string, status: 'created' | 'added' | 'updated' | 'unchanged' }[]}
 */
export function installAiRules(cwd = process.cwd(), { files } = {}) {
  let targets = files?.length ? files : AI_FILES.filter((f) => existsSync(join(cwd, f)))
  if (!targets.length) targets = ['AGENTS.md']
  return targets.map((file) => {
    const full = join(cwd, file)
    if (!existsSync(full)) {
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, `${AI_RULES}\n`)
      return { file, status: 'created' }
    }
    const text = readFileSync(full, 'utf8')
    const s = text.indexOf(START)
    const e = text.indexOf(END, s)
    if (s !== -1 && e !== -1) {
      const next = text.slice(0, s) + AI_RULES + text.slice(e + END.length)
      if (next === text) return { file, status: 'unchanged' }
      writeFileSync(full, next)
      return { file, status: 'updated' }
    }
    const gap = text === '' ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
    writeFileSync(full, `${text}${gap}${AI_RULES}\n`)
    return { file, status: 'added' }
  })
}
