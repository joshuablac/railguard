import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanText, scanFiles, scanStaged, checkEnvFiles, installHook } from '../src/secrets.js'

// Fixtures are assembled at runtime so this file never contains a real-looking secret
// (that would trip GitHub push protection and railguard's own scanner).
const S = {
  mongoPass: 'Zq' + '8vLm2Rt5Kx',
  aws: 'AK' + 'IA' + 'Z7X3Q9W2E5R8T1Y4',
  github: 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  stripe: 'sk' + '_live_' + '51HxYzAbCdEfGhIjKlMnOpQr',
  gmail: 'qwer' + 'tyui' + 'opas' + 'dfgh',
  jwtSecret: 'Xk9' + '#pL2$vQ8@mN4',
  pem: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
}
const mongoUri = 'mongodb+srv://josh:' + S.mongoPass + '@cluster0.example.net/app'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
}
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'rg-sec-'))
  git(dir, 'init', '-q')
  return dir
}

test('finds the common leaks and masks every one', () => {
  const text = [
    `const uri = "${mongoUri}"`,
    `AWS_ACCESS_KEY_ID=${S.aws}`,
    `const gh = '${S.github}'`,
    `stripe(${JSON.stringify(S.stripe)})`,
    `EMAIL_PASS=${S.gmail}`,
    S.pem,
  ].join('\n')
  const findings = scanText(text, { file: 'src/config.js' })
  assert.deepEqual(findings.map((f) => f.rule), ['database-url', 'aws-access-key', 'github-token', 'stripe-key', 'app-password', 'private-key'])
  const printed = JSON.stringify(findings)
  for (const secret of [S.mongoPass, S.aws, S.github, S.stripe, S.gmail]) {
    assert.ok(!printed.includes(secret), `leaked ${secret.slice(0, 4)}…`)
  }
  assert.equal(findings[0].preview, 'mongodb+srv://josh:********@')
  assert.equal(findings[1].preview, 'AKIA********')
  assert.deepEqual([findings[0].line, findings[0].column], [1, 14])
})

test('config files: any secret-named key with a real value', () => {
  const f = scanText(`JWT_SECRET="${S.jwtSecret}"\nPORT=3000\n`, { file: '.env.production' })
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, 'hardcoded-secret')
  assert.ok(!f[0].preview.includes(S.jwtSecret))
})

test('ignores placeholders and ordinary code', () => {
  const code = [
    'const password = req.body.password',
    'const token = jwt.sign(payload, process.env.JWT_SECRET)',
    "password: 'changeme'",
    'MONGO_URI=mongodb+srv://user:<password>@cluster0.example.net/db',
    "const API_KEY = process.env.API_KEY",
    'apiKey: "your-api-key-here"',
    `const pw = "${S.jwtSecret}" // railguard-ignore`,
    'if (password.length < 8) throw new Error("too short")',
  ].join('\n')
  assert.deepEqual(scanText(code, { file: 'src/auth.js' }), [])
  assert.deepEqual(scanText('JWT_SECRET=\nEMAIL_PASS=\n', { file: '.env.example' }), [])
})

test('no false positives on common library patterns', () => {
  const code = [
    'let lastSignificantToken = "?InterpolationInJSX"',
    '"tokenize": "./lib/tokenize.js",',
    'const nextToken = "RegularExpressionLiteral"',
    'passwordField: "user-password-input",',
  ].join('\n')
  assert.deepEqual(scanText(code, { file: 'dist/index.js' }), [])
  assert.deepEqual(scanText("auth: { username: 'janedoe', password: 's00pers3cret' }", { file: 'README.md' }), [])
  const real = scanText(`Use ${mongoUri} to connect`, { file: 'README.md' })
  assert.equal(real[0]?.rule, 'database-url', 'specific detectors still scan docs')
})

test('hard-coded high-entropy strings in code are caught', () => {
  const f = scanText(`const JWT_SECRET = '${S.jwtSecret}'`, { file: 'server.js' })
  assert.equal(f.length, 1)
})

test('scanFiles respects .gitignore and skips node_modules', () => {
  const dir = tempRepo()
  writeFileSync(join(dir, '.gitignore'), '.env\n')
  writeFileSync(join(dir, '.env'), `MONGO_URI=${mongoUri}\n`)
  writeFileSync(join(dir, 'app.js'), `const k = "${S.aws}"\n`)
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), `const k = "${S.aws}"\n`)
  const { findings } = scanFiles({ cwd: dir })
  assert.deepEqual(findings.map((f) => f.file), ['app.js'])
})

test('outside git, real .env files are skipped but examples are scanned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg-plain-'))
  writeFileSync(join(dir, '.env'), `MONGO_URI=${mongoUri}\n`)
  writeFileSync(join(dir, '.env.example'), `MONGO_URI=${mongoUri}\n`)
  const { findings } = scanFiles({ cwd: dir })
  assert.deepEqual(findings.map((f) => f.file), ['.env.example'])
})

test('scanStaged blocks staged .env files and staged secrets', () => {
  const dir = tempRepo()
  writeFileSync(join(dir, '.env'), 'PORT=1\n')
  writeFileSync(join(dir, 'db.js'), `module.exports = "${mongoUri}"\n`)
  writeFileSync(join(dir, 'clean.js'), 'module.exports = 1\n')
  git(dir, 'add', '.')
  const { findings } = scanStaged({ cwd: dir })
  assert.deepEqual(findings.map((f) => f.rule).sort(), ['database-url', 'env-file-staged'])
})

test('checkEnvFiles: tracked and un-ignored .env files', () => {
  const dir = tempRepo()
  writeFileSync(join(dir, '.env'), 'A=1\n')
  writeFileSync(join(dir, '.env.example'), 'A=\n')
  let problems = checkEnvFiles(dir)
  assert.equal(problems.length, 1)
  assert.match(problems[0].message, /\.env is not in \.gitignore/)

  writeFileSync(join(dir, '.gitignore'), '.env\n')
  assert.deepEqual(checkEnvFiles(dir), [])

  git(dir, 'add', '-f', '.env')
  problems = checkEnvFiles(dir)
  assert.equal(problems.length, 1)
  assert.match(problems[0].message, /\.env is tracked by git\. Run: git rm --cached \.env/)
})

test('installHook: installs once, never overwrites, respects core.hooksPath', () => {
  const dir = tempRepo()
  const first = installHook(dir)
  assert.equal(first.status, 'installed')
  assert.ok(statSync(first.path).mode & 0o100, 'hook is executable')
  assert.match(readFileSync(first.path, 'utf8'), /railguard scan --staged/)
  assert.equal(installHook(dir).status, 'already-installed')

  const other = tempRepo()
  mkdirSync(join(other, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(other, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnpm test\n')
  const r = installHook(other)
  assert.equal(r.status, 'exists')
  assert.equal(readFileSync(r.path, 'utf8'), '#!/bin/sh\nnpm test\n')

  const husky = tempRepo()
  git(husky, 'config', 'core.hooksPath', '.husky')
  const h = installHook(husky)
  assert.equal(h.status, 'installed')
  assert.ok(h.path.endsWith(join('.husky', 'pre-commit')))

  const husky9 = tempRepo()
  git(husky9, 'config', 'core.hooksPath', '.husky/_')
  const h9 = installHook(husky9)
  assert.ok(h9.path.endsWith(join('.husky', 'pre-commit')), 'husky v9: hook goes in .husky/, not the generated .husky/_')
})

test('installHook outside a repo explains what to do', () => {
  assert.throws(() => installHook(mkdtempSync(join(tmpdir(), 'rg-nogit-'))), /not a git repository/)
})
