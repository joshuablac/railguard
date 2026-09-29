import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probe, assertEdges, edge, guessArgs, EdgeCaseError } from '../src/edge.js'

test('finds the classic null crash and suggests a fix', async () => {
  const slugify = (s) => s.trim().toLowerCase().replace(/\s+/g, '-')
  const r = await probe(slugify, { args: ['string'] })
  assert.equal(r.ok, false)
  const labels = r.failed.map((f) => f.label)
  assert.ok(labels.includes('null'))
  assert.ok(labels.includes('undefined'))
  assert.ok(labels.includes('called with no arguments'))
  const nullCase = r.failed.find((f) => f.label === 'null')
  assert.equal(nullCase.kind, 'crash')
  assert.match(nullCase.hint, /null\/undefined check/)
  assert.match(String(r), /railguard probe · slugify\(string\)/)
})

test('a defensive function passes', async () => {
  const slugify = (s) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/\s+/g, '-') : '')
  const r = await probe(slugify, { args: ['string'] })
  assert.equal(r.ok, true, String(r))
  assert.ok(r.total > 30)
})

test('errors thrown on purpose are "rejected", not failures (unless strict)', async () => {
  const parse = (s) => {
    if (typeof s !== 'string') throw new TypeError('expected a string')
    return s.length
  }
  const r = await probe(parse, { args: ['string'] })
  assert.equal(r.ok, true)
  assert.ok(r.rejected.length > 0)
  const strict = await probe(parse, { args: ['string'], strict: true })
  assert.equal(strict.ok, false)
  assert.equal(strict.failed[0].kind, 'throws')
})

test('allow() whitelists expected errors', async () => {
  const f = (n) => BigInt(n) // throws RangeError for fractions
  const r = await probe(f, { args: ['number'], allow: (e) => e instanceof RangeError || e instanceof SyntaxError || e instanceof TypeError })
  assert.equal(r.ok, true, String(r))
})

test('catches NaN results, "[object Object]"/"undefined" in output, and invalid dates', async () => {
  const r1 = await probe((n) => Math.sqrt(n), { args: ['number'] })
  assert.ok(r1.failed.some((f) => f.kind === 'nan' && f.label === '-1'))

  const greet = (user) => `Hello ${user.name}`
  const r2 = await probe(greet, { args: ['object'], wrongTypes: false })
  assert.ok(r2.failed.some((f) => f.kind === 'output' && /undefined/.test(f.message)), String(r2))

  const r4 = await probe((u) => 'Hello ' + u.profile, { args: [edge.object({ sample: { profile: 'Jo' } })], wrongTypes: false })
  assert.ok(r4.failed.some((f) => f.kind === 'output'), 'object inputs no longer hide "undefined" output')
  const r5 = await probe((u) => `Hi ${u}`, { args: ['object'] })
  assert.match(r5.baselineError ?? '', /\[object Object\]/, '"[object Object]" is caught even though the input is an object')

  const addDay = (d) => new Date(d.getTime() + 864e5)
  const r3 = await probe(addDay, { args: ['date'], wrongTypes: false })
  assert.ok(r3.failed.some((f) => f.kind === 'invalid-date' || f.label === 'max Date'), String(r3))
})

test('catches functions that mutate their input', async () => {
  const sorted = (arr) => arr.sort()
  const r = await probe(sorted, { args: ['array'], wrongTypes: false })
  assert.ok(r.failed.some((f) => f.kind === 'mutation' || /read only|not extensible/.test(f.message)), String(r))
  const off = await probe((arr) => arr.sort(), { args: [edge.array({ sample: [1, 2, 3] })], wrongTypes: false, mutation: false })
  assert.ok(!off.failed.some((f) => f.kind === 'mutation'))
})

test('detects prototype pollution and cleans it up', async () => {
  function merge(target, source) {
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object') {
        target[key] = target[key] || {}
        merge(target[key], source[key])
      } else target[key] = source[key]
    }
    return target
  }
  const r = await probe((src) => merge({}, src), { args: ['object'], wrongTypes: false })
  const hit = r.failed.find((f) => f.kind === 'pollution')
  assert.ok(hit, String(r))
  assert.equal({}.railguardPolluted, undefined, 'Object.prototype was restored')
})

test('async hangs are caught with a timeout', async () => {
  const f = async (s) => {
    if (s === '') await new Promise(() => {})
    return s
  }
  const r = await probe(f, { args: ['string'], timeout: 30, wrongTypes: false })
  const hang = r.failed.find((x) => x.kind === 'timeout')
  assert.equal(hang?.label, 'empty string')
})

test('invariants', async () => {
  const clamp = (n) => Math.min(Math.max(n, 0), 100)
  const r = await probe(clamp, { args: ['number'], wrongTypes: false, invariant: (out) => out >= 0 && out <= 100 })
  assert.ok(r.failed.some((f) => f.label === 'NaN'), String(r))
})

test('multiple args vary one at a time; custom samples and cases', async () => {
  const price = (amount, currency) => `${currency.toUpperCase()} ${amount.toFixed(2)}`
  const r = await probe(price, { args: ['number', edge.custom('usd', ['', 'ngn'])] })
  assert.ok(r.failed.some((f) => f.arg === 0))
  assert.ok(r.failed.some((f) => f.arg === 1 && f.label === 'null'))
  assert.match(String(r), /arg 2: undefined, null/)
})

test('a sample that already fails stops early with advice', async () => {
  const email = (s) => {
    if (!s.includes('@')) throw new Error('bad email')
    return s
  }
  const r = await probe(email, { args: ['string'] })
  assert.equal(r.ok, false)
  assert.match(r.baselineError, /Pass a valid \{ sample \}/)
  const fixed = await probe(email, { args: [edge.string({ sample: 'a@b.co' })] })
  assert.equal(fixed.baselineError, undefined)
})

test('assertEdges throws a readable EdgeCaseError', async () => {
  await assert.rejects(() => assertEdges((s) => s.length, { args: ['string'] }), (e) => {
    assert.ok(e instanceof EdgeCaseError)
    assert.match(e.message, /✗ undefined, null/)
    return true
  })
  await assertEdges((s) => String(s ?? '').length, { args: ['string'] })
})

test('guessArgs finds a working baseline', async () => {
  assert.deepEqual((await guessArgs((s) => s.toUpperCase())).map((a) => a.type), ['string'])
  assert.deepEqual((await guessArgs((n) => n.toFixed(2))).map((a) => a.type), ['number'])
  const total = (items) => items.reduce((sum, i) => sum + i.price * i.quantity, 0)
  const specs = await guessArgs(total)
  assert.deepEqual(specs.map((a) => a.type), ['array'])
  const r = await probe(total, { args: specs })
  assert.equal(r.baselineError, undefined)
  assert.ok(r.failed.some((f) => f.kind === 'nan'), String(r))
  assert.equal(await guessArgs(() => {
    throw new Error('never works')
  }), null)
})

test('unknown arg types fail loudly', async () => {
  await assert.rejects(() => probe((x) => x, { args: ['strnig'] }), /unknown arg type "strnig"/)
  await assert.rejects(() => probe('nope'), TypeError)
})
