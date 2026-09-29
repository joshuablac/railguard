// Secret-leak scanner. Findings never contain the secret itself, only a masked preview.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const PLACEHOLDER = /(example|changeme|change_me|change-me|your[_-]|<|>|\$\{|\{\{|process\.env|xxxx|\*\*\*|placeholder|dummy|sample|redacted|replace|insert|fill[_-]?me|todo|fake|lorem|^pass(word)?$|^secret$|^test$|^none$|^null$)/i
const CONFIG_FILE = /(^|[\\/])\.env([.\w-]*)?$|\.(env|ini|cfg|conf|properties|ya?ml|toml)$/i
const ENV_FILE = /^\.env(\..+)?$/i
const ENV_TEMPLATE = /\.(example|sample|template|defaults?|dist)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.turbo', '.cache', '.vercel', 'vendor'])
const SKIP_FILES = /(^|[\\/])(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|.*\.min\.(js|css)|.*\.map)$/i
const MAX_BYTES = 1024 * 1024
const KNOWN_PREFIX = /^(AKIA|ASIA|gh[pousr]_|github_pat_|[sr]k_(?:live|test)_|xox[baprs]-|AIza|SG\.|eyJ|sk-ant-|sk-proj-|sk-)/

function entropy(s) {
  const counts = new Map()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

function looksLikePath(value) {
  return /^(\.{1,2}\/|\/|~\/)/.test(value) || /\.(c?js|mjs|tsx?|jsx|json|map|css|s[ac]ss|html?|md|ya?ml|node)$/i.test(value)
}

function looksLikeCode(value) {
  return /[()[\]{}]/.test(value) || /^[A-Za-z_$][\w$]*(\.[\w$]+)+$/.test(value) || /^(req|res|process|this|args?|opts?|options|config|env)\b/.test(value)
}

/** Mask a secret: keep only a well-known public prefix (e.g. "AKIA", "ghp_"). */
export function mask(secret) {
  const prefix = secret.match(KNOWN_PREFIX)?.[0] ?? ''
  return `${prefix}${'*'.repeat(8)}`
}

/**
 * Each rule: `re` must be global; `group` is the capture group holding the secret
 * (0 = whole match). `validate(secret, ctx)` can veto placeholders.
 */
export const RULES = [
  {
    id: 'private-key',
    title: 'Private key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/gd,
    group: 0,
  },
  {
    id: 'database-url',
    title: 'Database URL with a password',
    re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|rediss|amqps?|mssql):\/\/[^\s:@/'"`]+:([^\s@/'"`]+)@/gd,
    group: 1,
    validate: (s) => !PLACEHOLDER.test(s) && s.length >= 3,
  },
  { id: 'aws-access-key', title: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gd, group: 0 },
  {
    id: 'github-token',
    title: 'GitHub token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/gd,
    group: 0,
  },
  { id: 'stripe-key', title: 'Stripe secret key', re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{20,}\b/gd, group: 0 },
  { id: 'ai-api-key', title: 'AI provider API key (Anthropic / OpenAI)', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/gd, group: 0 },
  { id: 'google-api-key', title: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/gd, group: 0 },
  { id: 'slack-token', title: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gd, group: 0 },
  { id: 'sendgrid-key', title: 'SendGrid API key', re: /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}\b/gd, group: 0 },
  {
    id: 'jwt',
    title: 'JSON Web Token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gd,
    group: 0,
  },
  {
    id: 'app-password',
    title: 'Email app password (Gmail-style, 16 letters)',
    re: /\b[A-Za-z0-9_]*(?:PASS|PASSWORD|PWD)[A-Za-z0-9_]*\b['"]?\s*[:=]\s*['"`]?([a-z]{4}[ -]?[a-z]{4}[ -]?[a-z]{4}[ -]?[a-z]{4})(?![A-Za-z0-9])/gid,
    group: 1,
    validate: (s) => /^[a-z -]+$/.test(s) && !PLACEHOLDER.test(s),
  },
  {
    id: 'hardcoded-secret',
    title: 'Hard-coded secret',
    re: /\b[A-Za-z0-9_.-]*(?:secret|password|passwd|pwd|token|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?key|client[_-]?secret|_pass)[A-Za-z0-9_]*\b['"]?\s*[:=]\s*(['"`]?)([^\s'"`,;]{6,})\1/gid,
    group: 2,
    validate: (s, ctx) => {
      if (PLACEHOLDER.test(s) || looksLikeCode(s) || looksLikePath(s) || /^(.)\1+$/.test(s)) return false
      if (ctx.config) return true
      // In code, only quoted values that look generated: long, varied, with a digit and a letter.
      // This skips identifiers like "?InterpolationInJSX" that live in variables named *Token.
      if (ctx.markdown) return false
      return ctx.quoted && s.length >= 8 && entropy(s) >= 3 && /\d/.test(s) && /[A-Za-z]/.test(s)
    },
  },
]

/**
 * Scan text for secrets.
 * @param {string} text
 * @param {{ file?: string }} [options]
 * @returns {{ rule: string, title: string, file: string, line: number, column: number, preview: string }[]}
 */
export function scanText(text, { file = '<text>' } = {}) {
  const findings = []
  const config = CONFIG_FILE.test(file)
  const markdown = /\.(md|mdx|markdown|txt|rst)$/i.test(file)
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length > 5000 || line.includes('railguard-ignore')) continue
    const taken = []
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      for (const m of line.matchAll(rule.re)) {
        const secret = m[rule.group]
        if (!secret) continue
        const quoted = rule.id === 'hardcoded-secret' ? Boolean(m[1]) : true
        if (rule.validate && !rule.validate(secret, { config, quoted, markdown })) continue
        const start = m.index
        const end = m.index + m[0].length
        if (taken.some(([a, b]) => start < b && end > a)) continue
        taken.push([start, end])
        const [gs, ge] = m.indices[rule.group]
        let preview = m[0].slice(0, gs - start) + mask(secret) + m[0].slice(ge - start)
        if (preview.length > 160 || preview.includes(secret)) preview = mask(secret)
        findings.push({ rule: rule.id, title: rule.title, file, line: i + 1, column: start + 1, preview })
      }
    }
  }
  return findings
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: opts.encoding ?? 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
}

export function isGitRepo(cwd = process.cwd()) {
  try {
    return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'
  } catch {
    return false
  }
}

function isEnvFile(path) {
  const name = basename(path)
  return ENV_FILE.test(name) && !ENV_TEMPLATE.test(name)
}

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function walk(dir, root, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, root, out)
    } else if (e.isFile()) {
      out.push(relative(root, full))
    }
  }
}

/** Files that would be committed: tracked + untracked-but-not-ignored in git, or a plain walk otherwise. */
export function listFiles(cwd = process.cwd(), paths = []) {
  let files
  if (isGitRepo(cwd)) {
    const out = git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...(paths.length ? paths : ['.'])])
    files = [...new Set(out.split('\0').filter(Boolean))]
  } else {
    files = []
    const targets = paths.length ? paths : ['.']
    for (const p of targets) {
      const full = resolve(cwd, p)
      if (!existsSync(full)) continue
      if (statSync(full).isDirectory()) walk(full, cwd, files)
      else files.push(relative(cwd, full))
    }
    // Outside git we can't know what is ignored, so leave real .env files alone
    // (they are supposed to hold secrets); `checkEnvFiles` covers them instead.
    files = files.filter((f) => !isEnvFile(f))
  }
  return files.filter((f) => !SKIP_FILES.test(f) && !f.split(/[\\/]/).some((part) => SKIP_DIRS.has(part)))
}

/**
 * Scan a project directory (or specific paths) for secrets.
 * @param {{ cwd?: string, paths?: string[] }} [options]
 */
export function scanFiles({ cwd = process.cwd(), paths = [] } = {}) {
  const findings = []
  let scanned = 0
  for (const file of listFiles(cwd, paths)) {
    const full = isAbsolute(file) ? file : join(cwd, file)
    let buf
    try {
      const st = statSync(full)
      if (!st.isFile() || st.size > MAX_BYTES) continue
      buf = readFileSync(full)
    } catch {
      continue
    }
    if (isProbablyBinary(buf)) continue
    scanned++
    findings.push(...scanText(buf.toString('utf8'), { file: file.split(sep).join('/') }))
  }
  return { findings, scanned }
}

/** Scan only what is staged for the next commit (used by the pre-commit hook). */
export function scanStaged({ cwd = process.cwd() } = {}) {
  const findings = []
  const names = git(cwd, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean)
  let scanned = 0
  for (const file of names) {
    if (SKIP_FILES.test(file)) continue
    if (isEnvFile(file)) {
      findings.push({
        rule: 'env-file-staged',
        title: 'Environment file staged for commit',
        file,
        line: 0,
        column: 0,
        preview: `git rm --cached ${file}  (then add it to .gitignore)`,
      })
      continue
    }
    let buf
    try {
      buf = git(cwd, ['show', `:${file}`], { encoding: 'buffer' })
    } catch {
      continue
    }
    if (buf.length > MAX_BYTES || isProbablyBinary(buf)) continue
    scanned++
    findings.push(...scanText(buf.toString('utf8'), { file }))
  }
  return { findings, scanned }
}

/**
 * Repo hygiene for .env files: are they ignored? Are they (still) tracked?
 * A file that was committed once stays tracked even after you add it to .gitignore.
 */
export function checkEnvFiles(cwd = process.cwd()) {
  const problems = []
  let entries = []
  try {
    entries = readdirSync(cwd).filter(isEnvFile)
  } catch {
    return problems
  }
  const inGit = isGitRepo(cwd)
  let tracked = new Set()
  if (inGit) {
    try {
      tracked = new Set(git(cwd, ['ls-files', '-z']).split('\0').filter((f) => isEnvFile(f)))
    } catch {}
  }
  for (const f of tracked) {
    problems.push({ level: 'error', file: f, message: `${f} is tracked by git. Run: git rm --cached ${f}  (and rotate every secret it held)` })
  }
  for (const f of entries) {
    if (tracked.has(f)) continue
    if (inGit) {
      let ignored = false
      try {
        git(cwd, ['check-ignore', '-q', f])
        ignored = true
      } catch {}
      if (!ignored) problems.push({ level: 'error', file: f, message: `${f} is not in .gitignore, so the next "git add ." will commit it` })
    } else {
      const gi = join(cwd, '.gitignore')
      const text = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
      if (!/^\/?\.env(\*|\..*)?$/m.test(text)) {
        problems.push({ level: 'warn', file: f, message: `${f} exists but .gitignore does not list .env. Add ".env*" before running git init` })
      }
    }
  }
  return problems
}

const HOOK_MARK = '# railguard'
const HOOK_BODY = `#!/bin/sh
${HOOK_MARK}: block commits that contain secrets or .env files
npx --no -- railguard scan --staged || exit 1
`

/**
 * Install a git pre-commit hook. Respects core.hooksPath (husky etc.) and never
 * overwrites an existing hook.
 * @returns {{ status: 'installed' | 'already-installed' | 'exists', path: string, line: string }}
 */
export function installHook(cwd = process.cwd()) {
  if (!isGitRepo(cwd)) throw new Error('railguard: not a git repository. Run "git init" first.')
  let hooksDir
  try {
    hooksDir = git(cwd, ['config', 'core.hooksPath']).trim()
  } catch {}
  if (hooksDir) {
    const top = git(cwd, ['rev-parse', '--show-toplevel']).trim()
    hooksDir = resolve(top, hooksDir)
    // husky v9 points core.hooksPath at the generated `.husky/_`; user hooks live one level up.
    if (basename(hooksDir) === '_' && basename(dirname(hooksDir)) === '.husky') hooksDir = dirname(hooksDir)
  } else {
    hooksDir = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'hooks']).trim())
  }
  const hookPath = join(hooksDir, 'pre-commit')
  const line = 'npx --no -- railguard scan --staged || exit 1'
  if (existsSync(hookPath)) {
    const current = readFileSync(hookPath, 'utf8')
    return { status: current.includes('railguard') ? 'already-installed' : 'exists', path: hookPath, line }
  }
  mkdirSync(hooksDir, { recursive: true })
  writeFileSync(hookPath, HOOK_BODY)
  chmodSync(hookPath, 0o755)
  return { status: 'installed', path: hookPath, line }
}
