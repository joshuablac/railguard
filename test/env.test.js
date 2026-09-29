import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { guard, envExample, EnvError, t } from '../src/index.js'

const schema = {
  NODE_ENV: t.enum(['development', 'production', 'test']).default('development'),
  PORT: t.port().default(3000),
  MONGO_URI: t.url().describe('MongoDB connection string'),
  JWT_SECRET: t.string({ min: 32 }),
  DEBUG: t.boolean().default(false),
  SENTRY_DSN: t.url().optional(),
}

const LONG = 'k'.repeat(40)

test('coerces and applies defaults', () => {
  const env = guard(schema, { source: { MONGO_URI: 'mongodb://localhost:27017/app', JWT_SECRET: LONG, DEBUG: 'false', PORT: '8080' } })
  assert.equal(env.PORT, 8080)
  assert.equal(env.DEBUG, false)
  assert.equal(env.NODE_ENV, 'development')
  assert.equal(env.SENTRY_DSN, undefined)
})

test('empty strings count as missing', () => {
  const env = guard({ PORT: t.port().default(3000) }, { source: { PORT: '' } })
  assert.equal(env.PORT, 3000)
  assert.throws(() => guard({ KEY: t.string() }, { source: { KEY: '   ' } }), EnvError)
})

test('reports every problem at once, without printing values', () => {
  const secretish = ['hunter2', 'should', 'never', 'be', 'printed'].join('-')
  try {
    guard(schema, { source: { PORT: secretish, JWT_SECRET: 'short', NODE_ENV: 'prod' } })
    assert.fail('should throw')
  } catch (e) {
    assert.ok(e instanceof EnvError)
    assert.deepEqual(e.issues.map((i) => i.path).sort(), ['JWT_SECRET', 'MONGO_URI', 'NODE_ENV', 'PORT'])
    assert.match(e.message, /4 environment variables need attention/)
    assert.match(e.message, /MONGO_URI\s+is required, expected a URL — MongoDB connection string/)
    assert.ok(!e.message.includes(secretish))
    assert.ok(!e.message.includes('short'))
  }
})

test('the env object is frozen and typo-proof', () => {
  const env = guard({ PORT: t.port() }, { source: { PORT: '1' } })
  assert.throws(() => env.PROT, /env\.PROT is not in your env schema/)
  assert.throws(() => {
    env.PORT = 2
  }, TypeError)
  assert.equal(env.then, undefined, 'safe to await / return from async functions')
  assert.equal(JSON.stringify(env), '{"PORT":1}')
})

test('secrets are hidden when the env object is logged', () => {
  const env = guard(
    { API_TOKEN: t.string(), DB: t.url(), NAME: t.string(), CUSTOM: t.string().secret() },
    { source: { API_TOKEN: ['tok', '123456'].join('-'), DB: 'mongodb+srv://u:' + 'pw1234' + '@h.example.net/x', NAME: 'app', CUSTOM: 'c-999' } }
  )
  const out = inspect(env)
  for (const hidden of ['tok-123456', 'pw1234', 'c-999']) assert.ok(!out.includes(hidden), `${hidden} leaked: ${out}`)
  assert.match(out, /NAME: 'app'/)
  assert.match(out, /\[secret\]/)
})

test('loads a .env file underneath the given source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg-env-'))
  const file = join(dir, '.env')
  writeFileSync(file, 'PORT=4000\nNAME="from file"\n')
  const env = guard({ PORT: t.port(), NAME: t.string() }, { source: { NAME: 'from source' }, file })
  assert.equal(env.PORT, 4000)
  assert.equal(env.NAME, 'from source', 'explicit source wins over the file')
})

test('process.env mode fills process.env from the file without overriding it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg-env-'))
  const file = join(dir, '.env')
  writeFileSync(file, 'RG_TEST_A=file\nRG_TEST_B=file\n')
  process.env.RG_TEST_B = 'real'
  try {
    const env = guard({ RG_TEST_A: t.string(), RG_TEST_B: t.string() }, { file })
    assert.equal(env.RG_TEST_A, 'file')
    assert.equal(env.RG_TEST_B, 'real')
    assert.equal(process.env.RG_TEST_A, 'file')
  } finally {
    delete process.env.RG_TEST_A
    delete process.env.RG_TEST_B
  }
})

test('onError lets you decide what happens', () => {
  const r = guard({ X: t.string() }, { source: {}, onError: (e) => e.issues.length })
  assert.equal(r, 1)
})

test('rejects a schema that is not made of fields', () => {
  assert.throws(() => guard({ PORT: 'number' }, { source: {} }), /schema\.PORT is not a railguard field/)
  assert.throws(() => guard(null), TypeError)
})

test('envExample writes a template without secret defaults', () => {
  const text = envExample({
    PORT: t.port().default(3000),
    JWT_SECRET: t.string().default('do-not-print-me'),
    MONGO_URI: t.url().describe('MongoDB connection string'),
    DEBUG: t.boolean().optional(),
  })
  assert.match(text, /^PORT=3000$/m)
  assert.match(text, /^JWT_SECRET=$/m)
  assert.ok(!text.includes('do-not-print-me'))
  assert.match(text, /# MongoDB connection string — a URL, required/)
  assert.match(text, /# true or false, optional/)
})
