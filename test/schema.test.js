import { test } from 'node:test'
import assert from 'node:assert/strict'
import { t, check } from '../src/index.js'

const coerce = { coerce: true }

test('number: strict parsing when coercing strings', () => {
  assert.deepEqual(t.number().parse('42', coerce), { ok: true, value: 42 })
  assert.deepEqual(t.number().parse(' -1.5e2 ', coerce), { ok: true, value: -150 })
  for (const bad of ['12abc', '0x10', 'Infinity', 'NaN', '1,000', '--1']) {
    assert.equal(t.number().parse(bad, coerce).ok, false, bad)
  }
  assert.equal(t.number().parse('1e400', coerce).ok, false, 'overflow to Infinity is rejected')
  assert.equal(t.number().parse('42').ok, false, 'no coercion outside env/query')
  assert.equal(t.number().parse(NaN).ok, false)
})

test('int and port', () => {
  assert.equal(t.int().parse(1.5).ok, false)
  assert.equal(t.int().parse(2 ** 60).ok, false, 'unsafe integers are rejected')
  assert.equal(t.port().parse('0', coerce).ok, false)
  assert.equal(t.port().parse('65536', coerce).ok, false)
  assert.deepEqual(t.port().parse('8080', coerce), { ok: true, value: 8080 })
})

test('boolean understands common env spellings', () => {
  for (const s of ['true', 'TRUE', '1', 'yes', 'on']) assert.equal(t.boolean().parse(s, coerce).value, true, s)
  for (const s of ['false', '0', 'no', 'off', ' False ']) assert.equal(t.boolean().parse(s, coerce).value, false, s)
  assert.equal(t.boolean().parse('maybe', coerce).ok, false)
  assert.equal(t.boolean().parse('true').ok, false, 'body mode needs a real boolean')
})

test('string, enum, url, email', () => {
  assert.equal(t.string({ min: 2 }).parse('a').ok, false)
  assert.equal(t.string({ pattern: /^[a-z]+$/g }).parse('abc').ok, true)
  assert.equal(t.string({ pattern: /^[a-z]+$/g }).parse('abc').ok, true, 'global regex lastIndex is reset')
  assert.equal(t.string({ trim: true, min: 1 }).parse('   ').ok, false)
  assert.equal(t.enum(['a', 'b']).parse('c').ok, false)
  assert.throws(() => t.enum([]), TypeError)
  assert.equal(t.url().parse('not a url').ok, false)
  assert.equal(t.url({ protocols: ['https'] }).parse('http://x.com').ok, false)
  assert.equal(t.url().parse('mongodb+srv://u:p@cluster.example.net/db').ok, true)
  assert.equal(t.email().parse('a@b').ok, false)
  assert.equal(t.email({ normalize: true }).parse('  Josh@Example.COM ').value, 'josh@example.com')
})

test('missing values: required, optional, default, null', () => {
  assert.deepEqual(t.string().parse(undefined).issues, [{ path: '(value)', message: 'is required' }])
  assert.equal(t.string().parse(null).ok, false)
  assert.deepEqual(t.string().optional().parse(undefined), { ok: true, value: undefined })
  assert.deepEqual(t.int().default(3).parse(undefined), { ok: true, value: 3 })
  const a = t.array(t.int()).default(() => [])
  assert.notEqual(a.parse(undefined).value, a.parse(undefined).value, 'function defaults are fresh each time')
})

test('object strips unknown keys by default (mass-assignment protection)', () => {
  const user = { name: t.string(), email: t.email() }
  const r = check(user, { name: 'Jo', email: 'jo@x.co', role: 'admin' })
  assert.deepEqual(r, { ok: true, value: { name: 'Jo', email: 'jo@x.co' } })
  const rejected = check(t.object(user, { unknown: 'reject' }), { name: 'Jo', email: 'jo@x.co', role: 'admin' })
  assert.deepEqual(rejected.issues, [{ path: 'role', message: 'is not allowed' }])
  const kept = check(t.object({}, { unknown: 'keep' }), JSON.parse('{"__proto__":{"x":1},"a":1}'))
  assert.deepEqual(Object.keys(kept.value), ['a'], '__proto__ is never copied')
  assert.equal({}.x, undefined)
})

test('reports every issue with a path, never the value', () => {
  const r = check(
    { email: t.email(), tags: t.array(t.string({ min: 1 })), address: t.object({ city: t.string() }) },
    { email: 'SECRET-VALUE-123', tags: ['ok', ''], address: {} }
  )
  assert.equal(r.ok, false)
  assert.deepEqual(r.issues.map((i) => i.path), ['email', 'tags[1]', 'address.city'])
  assert.ok(!JSON.stringify(r.issues).includes('SECRET-VALUE-123'))
})

test('array coerces comma lists (query strings / env)', () => {
  assert.deepEqual(t.array(t.int()).parse('1, 2,3', coerce).value, [1, 2, 3])
  assert.deepEqual(t.array(t.string()).parse('', coerce).value, [])
  assert.equal(t.array(t.int(), { max: 2 }).parse([1, 2, 3]).ok, false)
})

test('toField rejects things that are not fields', () => {
  assert.throws(() => check(42, {}), TypeError)
  assert.throws(() => t.object({ a: 'string' }), TypeError)
})
