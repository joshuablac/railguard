import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'railguard.js')
const PASS = 'Qm' + '7rTx4Lw9Pz'
const MONGO = 'mongodb+srv://josh:' + PASS + '@cluster0.example.net/app'

function project({ git = false, type } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rg-cli-'))
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(ROOT, join(dir, 'node_modules', 'railguard'), 'dir')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', ...(type ? { type } : {}) }))
  if (git) execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
  return { code: r.status, out: r.stdout + r.stderr }
}

test('--help and --version', () => {
  const dir = project()
  assert.match(run(dir, '--help').out, /railguard check/)
  assert.equal(run(dir, '-v').out.trim(), JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version)
  assert.equal(run(dir, 'nope').code, 2)
})

test('init → check: CommonJS project (like a typical Express server)', () => {
  const dir = project({ git: true })
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n.env\n')
  writeFileSync(join(dir, '.env.example'), 'PORT=5000\nMONGO_DB=\nJWT_SECRET=\nSENDER_EMAIL=\nEMAIL_PASS=\nDEBUG=false\n')
  const init = run(dir, 'init')
  assert.equal(init.code, 0, init.out)
  const schema = readFileSync(join(dir, 'env.schema.js'), 'utf8')
  assert.match(schema, /require\('railguard'\)/)
  assert.match(schema, /PORT: t\.port\(\)\.default\(5000\)/)
  assert.match(schema, /MONGO_DB: t\.url\(\)/)
  assert.match(schema, /JWT_SECRET: t\.string\(\{ min: 1 \}\)\.secret\(\)/)
  assert.match(schema, /SENDER_EMAIL: t\.email\(\)/)
  assert.match(schema, /DEBUG: t\.boolean\(\)/)
  assert.equal(run(dir, 'init').code, 0, 'second init leaves the file alone')

  writeFileSync(join(dir, '.env'), `MONGO_DB=${MONGO}\nJWT_SECRET=abc\nSENDER_EMAIL=not-an-email\nEMAIL_PASS=x\nDEBUG=maybe\n`)
  const bad = run(dir, 'check')
  assert.equal(bad.code, 1)
  assert.match(bad.out, /SENDER_EMAIL\s+must be a valid email address/)
  assert.match(bad.out, /DEBUG\s+must be true or false/)
  assert.ok(!bad.out.includes(PASS) && !bad.out.includes('not-an-email'), 'values are never printed')

  writeFileSync(join(dir, '.env'), `MONGO_DB=${MONGO}\nJWT_SECRET=abc\nSENDER_EMAIL=a@b.co\nEMAIL_PASS=x\nDEBUG=false\n`)
  const good = run(dir, 'check')
  assert.equal(good.code, 0, good.out)
  assert.match(good.out, /6 variables match env\.schema\.js/)
})

test('init writes ESM for "type": "module" projects, and example prints a template', () => {
  const dir = project({ type: 'module' })
  writeFileSync(join(dir, '.env.example'), 'PORT=3000\nAPI_KEY=\n')
  assert.equal(run(dir, 'init').code, 0)
  assert.match(readFileSync(join(dir, 'env.schema.js'), 'utf8'), /import \{ t \} from 'railguard'/)
  const ex = run(dir, 'example')
  assert.equal(ex.code, 0, ex.out)
  assert.match(ex.out, /^PORT=3000$/m)
  assert.match(ex.out, /^API_KEY=$/m)
})

test('check without a schema compares .env with .env.example and flags un-ignored .env', () => {
  const dir = project({ git: true })
  writeFileSync(join(dir, '.env.example'), 'A=\nB=\n')
  writeFileSync(join(dir, '.env'), 'A=1\nC=3\n')
  const r = run(dir, 'check')
  assert.equal(r.code, 1)
  assert.match(r.out, /B is in \.env\.example but missing/)
  assert.match(r.out, /C is in \.env but not in \.env\.example/)
  assert.match(r.out, /\.env is not in \.gitignore/)
})

test('scan: exits 1 with masked findings, 0 when clean', () => {
  const dir = project({ git: true })
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
  writeFileSync(join(dir, 'db.js'), `module.exports = '${MONGO}'\n`)
  const r = run(dir, 'scan')
  assert.equal(r.code, 1)
  assert.match(r.out, /db\.js:1:19\s+Database URL with a password/)
  assert.match(r.out, /mongodb\+srv:\/\/josh:\*{8}@/)
  assert.ok(!r.out.includes(PASS), 'secret must never be printed')

  writeFileSync(join(dir, 'db.js'), 'module.exports = process.env.MONGO_DB\n')
  assert.equal(run(dir, 'scan').code, 0)
})

test('hook + scan --staged', () => {
  const dir = project({ git: true })
  const hook = run(dir, 'hook')
  assert.equal(hook.code, 0)
  assert.match(hook.out, /pre-commit hook installed/)
  assert.ok(existsSync(join(dir, '.git', 'hooks', 'pre-commit')))

  writeFileSync(join(dir, '.env'), 'X=1\n')
  execFileSync('git', ['add', '-f', '.env'], { cwd: dir })
  const r = run(dir, 'scan', '--staged')
  assert.equal(r.code, 1)
  assert.match(r.out, /Environment file staged for commit/)
  assert.match(r.out, /git rm --cached \.env/)
})

test('probe: finds crashes in exported functions, passes robust ones', () => {
  const dir = project({ type: 'module' })
  writeFileSync(
    join(dir, 'utils.js'),
    `export const slugify = (s) => s.trim().toLowerCase().replace(/\\s+/g, '-')
export const safeSlug = (s) => String(s ?? '').trim().toLowerCase().replace(/\\s+/g, '-')
export const total = (items) => items.reduce((sum, i) => sum + i.price, 0)
export class NotAFunction {}
`
  )
  const all = run(dir, 'probe', 'utils.js')
  assert.equal(all.code, 1)
  assert.match(all.out, /probe · slugify\(string\)/)
  assert.match(all.out, /probe · safeSlug\(string\)[\s\S]*?✓ no crashes found/)
  assert.match(all.out, /probe · total\(array\)/)
  assert.doesNotMatch(all.out, /NotAFunction/)

  const one = run(dir, 'probe', 'utils.js', 'safeSlug', '--args', 'string')
  assert.equal(one.code, 0, one.out)

  assert.equal(run(dir, 'probe', 'utils.js', 'missing').code, 2)
  assert.equal(run(dir, 'probe', 'nope.js').code, 2)
})
