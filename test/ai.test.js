import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installAiRules, AI_RULES, AI_RULES_BODY } from '../src/ai.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => mkdtempSync(join(tmpdir(), 'rg-ai-'))

test('creates AGENTS.md when the project has no instruction file', () => {
  const dir = tmp()
  assert.deepEqual(installAiRules(dir), [{ file: 'AGENTS.md', status: 'created' }])
  const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  assert.match(text, /^<!-- railguard:start/)
  assert.match(text, /must be rotated/)
  assert.match(text, /<!-- railguard:end -->\n$/)
})

test('adds to existing files without touching their content, and is idempotent', () => {
  const dir = tmp()
  const mine = '# My project\n\nUse tabs. Deploy with `npm run ship`.\n'
  writeFileSync(join(dir, 'CLAUDE.md'), mine)
  mkdirSync(join(dir, '.github'))
  writeFileSync(join(dir, '.github', 'copilot-instructions.md'), 'Prefer async/await.')
  const first = installAiRules(dir)
  assert.deepEqual(first.map((r) => [r.file, r.status]), [
    ['CLAUDE.md', 'added'],
    ['.github/copilot-instructions.md', 'added'],
  ])
  assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'no extra file when one already exists')
  const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
  assert.ok(claude.startsWith(mine), 'original content is kept exactly')
  assert.equal(claude.split('railguard:start').length, 2)
  assert.ok(readFileSync(join(dir, '.github', 'copilot-instructions.md'), 'utf8').startsWith('Prefer async/await.\n\n<!-- railguard:start'))

  const second = installAiRules(dir)
  assert.deepEqual(second.map((r) => r.status), ['unchanged', 'unchanged'])
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), claude)
})

test('replaces an older railguard block in place', () => {
  const dir = tmp()
  const old = 'Intro\n\n<!-- railguard:start (old) -->\nold rules\n<!-- railguard:end -->\n\nOutro\n'
  writeFileSync(join(dir, 'AGENTS.md'), old)
  assert.deepEqual(installAiRules(dir), [{ file: 'AGENTS.md', status: 'updated' }])
  const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  assert.equal(text, `Intro\n\n${AI_RULES}\n\nOutro\n`)
})

test('--file targets one file; --print writes nothing', () => {
  const dir = tmp()
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'bin', 'railguard.js'), 'ai', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  const printed = run('--print')
  assert.equal(printed.status, 0)
  assert.equal(printed.stdout.trim(), AI_RULES)
  assert.ok(!existsSync(join(dir, 'AGENTS.md')))

  const r = run('--file', '.cursorrules')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /created \.cursorrules/)
  assert.ok(existsSync(join(dir, '.cursorrules')))
  assert.ok(!existsSync(join(dir, 'AGENTS.md')))
})

test('llms.txt carries the same rules as the command', () => {
  const llms = readFileSync(join(ROOT, 'llms.txt'), 'utf8')
  const lines = AI_RULES_BODY.split('\n').filter((l) => l.trim() && !l.startsWith('## '))
  for (const line of lines) assert.ok(llms.includes(line), `llms.txt is missing: ${line.slice(0, 60)}`)
})
