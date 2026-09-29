// Edge-case prober: calls a function with the inputs that most often break
// JavaScript (null, empty strings, NaN, -0, huge values, emoji, sparse arrays,
// __proto__ payloads, invalid dates, frozen objects...) and reports what crashed.
//
// Limits, stated plainly: it cannot catch an infinite loop in synchronous code
// (JavaScript can't interrupt it); async hangs are caught with a timeout.
import { inspect } from 'node:util'

const c = (label, make) => ({ label, make })

const STRING_CASES = [
  c('empty string', () => ''),
  c('single space', () => ' '),
  c('whitespace only', () => ' \t\n '),
  c('single character', () => 'a'),
  c('leading/trailing spaces', () => '  padded  '),
  c('very long string (10k chars)', () => 'x'.repeat(10_000)),
  c('accented text', () => 'héllo wörld'),
  c('combining character (e + ◌́)', () => 'é'),
  c('emoji', () => '🙂'),
  c('family emoji (ZWJ sequence)', () => '👨‍👩‍👧'),
  c('lone surrogate', () => '\uD800'),
  c('right-to-left text', () => 'مرحبا'),
  c('null byte', () => 'a\u0000b'),
  c('newlines', () => 'line1\nline2\r\n'),
  c('HTML/script injection', () => '<script>alert(1)</script>'),
  c('SQL injection', () => "' OR '1'='1"),
  c('path traversal', () => '../../etc/passwd'),
  c('malformed percent-encoding', () => '%E0%A4%A'),
  c('"__proto__"', () => '__proto__'),
  c('"constructor"', () => 'constructor'),
  c('the text "null"', () => 'null'),
  c('the text "undefined"', () => 'undefined'),
  c('the text "0"', () => '0'),
  c('the text "-1"', () => '-1'),
  c('the text "NaN"', () => 'NaN'),
  c('the text "false"', () => 'false'),
  c('number-like overflow "1e400"', () => '1e400'),
]

const NUMBER_CASES = [
  c('0', () => 0),
  c('-0', () => -0),
  c('1', () => 1),
  c('-1', () => -1),
  c('decimal 0.1', () => 0.1),
  c('float error 0.1+0.2', () => 0.1 + 0.2),
  c('fraction 1.5', () => 1.5),
  c('2^31 (int32 overflow)', () => 2 ** 31),
  c('2^32', () => 2 ** 32),
  c('MAX_SAFE_INTEGER', () => Number.MAX_SAFE_INTEGER),
  c('beyond MAX_SAFE_INTEGER', () => Number.MAX_SAFE_INTEGER + 2),
  c('Number.MAX_VALUE', () => Number.MAX_VALUE),
  c('Number.MIN_VALUE (5e-324)', () => Number.MIN_VALUE),
  c('1e21 (prints in e-notation)', () => 1e21),
  c('-1e21', () => -1e21),
  c('NaN', () => NaN),
  c('Infinity', () => Infinity),
  c('-Infinity', () => -Infinity),
]

const BOOLEAN_CASES = [
  c('true', () => true),
  c('false', () => false),
  c('the string "false" (truthy!)', () => 'false'),
  c('the string "true"', () => 'true'),
  c('0', () => 0),
  c('1', () => 1),
]

const ARRAY_CASES = [
  c('empty array', () => []),
  c('one item', () => [1]),
  c('[undefined]', () => [undefined]),
  c('[null]', () => [null]),
  c('[NaN]', () => [NaN]),
  c('sparse array (hole)', () => [1, , 3]), // eslint-disable-line no-sparse-arrays
  c('duplicates', () => [1, 1, 1]),
  c('mixed types', () => [1, '1', null, {}, [], true]),
  c('nested arrays', () => [[1, [2, [3]]]]),
  c('large array (10k items)', () => Array.from({ length: 10_000 }, (_, i) => i)),
  c('frozen array', () => Object.freeze([1, 2, 3])),
]

function deep(depth) {
  let o = {}
  const root = o
  for (let i = 0; i < depth; i++) o = o.child = {}
  return root
}

const OBJECT_CASES = [
  c('empty object', () => ({})),
  c('null-prototype object', () => Object.assign(Object.create(null), { id: 1 })),
  c('__proto__ key (prototype pollution)', () => JSON.parse('{"__proto__":{"railguardPolluted":true},"id":1}')),
  c('Mongo operator { $gt: "" } (NoSQL injection)', () => ({ $gt: '' })),
  c('keys with undefined values', () => ({ id: undefined, name: undefined })),
  c('circular reference', () => {
    const o = { id: 1 }
    o.self = o
    return o
  }),
  c('deeply nested (depth 1000)', () => deep(1000)),
  c('frozen object', () => Object.freeze({ id: 1, name: 'frozen' })),
  c('array-like { length: 2 }', () => ({ length: 2 })),
  c('Map instead of object', () => new Map([['id', 1]])),
  c('Date instead of object', () => new Date(0)),
]

const DATE_CASES = [
  c('Invalid Date', () => new Date(NaN)),
  c('Unix epoch (1970-01-01)', () => new Date(0)),
  c('before 1970', () => new Date(-1)),
  c('leap day 2024-02-29', () => new Date('2024-02-29T12:00:00Z')),
  c('last millisecond of a year', () => new Date('2024-12-31T23:59:59.999Z')),
  c('year 9999', () => new Date('9999-12-31T00:00:00Z')),
  c('max Date', () => new Date(8.64e15)),
  c('frozen Date', () => Object.freeze(new Date(0))),
]

const NULLISH = [c('undefined', () => undefined), c('null', () => null)]

function wrongTypes(except) {
  const all = {
    string: c('wrong type: string "abc"', () => 'abc'),
    number: c('wrong type: number 42', () => 42),
    boolean: c('wrong type: boolean true', () => true),
    array: c('wrong type: array', () => ['a']),
    object: c('wrong type: object', () => ({ a: 1 })),
    bigint: c('wrong type: BigInt 10n', () => 10n),
    function: c('wrong type: function', () => () => {}),
  }
  return Object.entries(all).filter(([k]) => !except.includes(k)).map(([, v]) => v)
}

/** @typedef {{ type: string, sample: () => unknown, cases: {label: string, make: () => unknown}[], wrong: {label: string, make: () => unknown}[] }} ArgSpec */

function spec(type, sample, cases, wrong, opts = {}) {
  const s = opts.sample
  return {
    type,
    sample: s === undefined ? sample : () => (typeof s === 'function' && type !== 'function' ? s() : structuredCloneSafe(s)),
    cases: [...cases, ...(opts.extra ?? []).map((v, i) => c(`custom #${i + 1}: ${preview(v)}`, () => structuredCloneSafe(v)))],
    wrong,
  }
}

/** Argument specs. Each accepts `{ sample }` (a valid value for your function) and `{ extra: [...] }`. */
export const edge = {
  string: (opts) => spec('string', () => 'hello world', STRING_CASES, wrongTypes(['string']), opts),
  number: (opts) => spec('number', () => 42, NUMBER_CASES, [...wrongTypes(['number']), c('numeric string "42"', () => '42'), c('empty string', () => '')], opts),
  boolean: (opts) => spec('boolean', () => true, BOOLEAN_CASES, wrongTypes(['boolean', 'number']), opts),
  array: (opts) => spec('array', () => [1, 2, 3], ARRAY_CASES, [...wrongTypes(['array']), c('string (has .length too)', () => 'abc'), c('Set instead of array', () => new Set([1, 2]))], opts),
  object: (opts) => spec('object', () => ({ id: 1, name: 'test' }), OBJECT_CASES, [...wrongTypes(['object']), c('array instead of object', () => [{ id: 1 }])], opts),
  date: (opts) => spec('date', () => new Date('2024-06-15T12:00:00Z'), DATE_CASES, [...wrongTypes([]), c('date string "2024-01-01"', () => '2024-01-01'), c('timestamp number', () => 1704067200000)], opts),
  any: (opts) =>
    spec(
      'any',
      () => 'hello world',
      [
        ...STRING_CASES.slice(0, 6),
        ...NUMBER_CASES.filter((x) => ['0', '-0', 'NaN', 'Infinity', 'beyond MAX_SAFE_INTEGER'].includes(x.label)),
        ...ARRAY_CASES.slice(0, 3),
        ...OBJECT_CASES.slice(0, 3),
        DATE_CASES[0],
        c('BigInt 10n', () => 10n),
        c('function', () => () => {}),
        c('Symbol', () => Symbol('x')),
      ],
      [],
      opts
    ),
  /** Your own cases: `edge.custom('valid@mail.com', ['a@', '@b.c', 'A@B.COM'])` */
  custom: (sample, cases = []) =>
    spec('custom', undefined, [], [], { sample, extra: cases }),
}

const TYPE_NAMES = Object.keys(edge).filter((k) => k !== 'custom')

function toSpec(arg) {
  if (typeof arg === 'string') {
    const make = edge[arg === 'int' || arg === 'integer' ? 'number' : arg]
    if (!make || arg === 'custom') throw new TypeError(`railguard: unknown arg type "${arg}". Use one of: ${TYPE_NAMES.join(', ')}`)
    return make()
  }
  if (arg && typeof arg === 'object' && typeof arg.sample === 'function' && Array.isArray(arg.cases)) return arg
  throw new TypeError('railguard: each arg must be a type name ("string", "number", ...) or edge.string({...}) etc.')
}

// Messages V8 produces for accidental, input-driven crashes. A function that throws
// one of these did not choose to reject the input; it fell over.
const ACCIDENTAL = [
  [/Cannot read propert(y|ies) of (undefined|null)/, 'add a null/undefined check or a default value'],
  [/Cannot set propert(y|ies) of (undefined|null)/, 'the object you write to can be missing; create it first'],
  [/Cannot destructure/, 'give the destructured parameter a default: ({ a } = {})'],
  [/Cannot convert undefined or null to object/, 'check the value before Object.keys/entries/assign'],
  [/is not a function/, 'check the type before calling a method on it'],
  [/is not iterable/, 'check Array.isArray() (or that it is iterable) before looping or spreading'],
  [/is not a constructor/, 'check the type before using `new`'],
  [/Maximum call stack size exceeded/, 'recursion has no depth limit or cycle check'],
  [/Converting circular structure to JSON/, 'guard JSON.stringify against circular objects'],
  [/Invalid array length/, 'validate lengths/sizes before creating arrays'],
  [/Invalid string length/, 'cap the size of strings you build'],
  [/Invalid count value/, 'validate the count passed to String.prototype.repeat'],
  [/Invalid time value/, 'check isNaN(date.getTime()) before formatting a date'],
  [/Cannot mix BigInt/, 'reject or convert BigInt input before arithmetic'],
  [/Cannot convert a BigInt|to a BigInt|serialize a BigInt/, 'handle BigInt explicitly'],
  [/Cannot convert a Symbol/, 'handle Symbol input explicitly (String(sym) works, `${sym}` throws)'],
  [/Cannot convert object to primitive value/, 'null-prototype objects have no toString; avoid implicit string conversion'],
  [/Reduce of empty array with no initial value/, 'pass an initial value to reduce()'],
  [/URI malformed/, 'wrap decodeURIComponent/decodeURI in try/catch'],
  [/is not valid JSON|Unexpected (token|end of JSON)/, 'wrap JSON.parse in try/catch'],
  [/Invalid regular expression/, 'escape user input before building a RegExp'],
  [/Cannot assign to read only property|object is not extensible|Cannot add property|Cannot delete property/, 'the function mutates its input; copy it first'],
  [/toFixed\(\) digits|toPrecision\(\) argument|radix must be/, 'validate numeric formatting arguments'],
  [/Cannot create property/, 'the value is a primitive, not an object; check the type first'],
]

const NATIVE_ERRORS = new Set([TypeError, RangeError, SyntaxError, URIError, ReferenceError])

function classify(error) {
  const msg = error instanceof Error ? error.message : ''
  if (error instanceof Error && NATIVE_ERRORS.has(error.constructor)) {
    for (const [re, hint] of ACCIDENTAL) if (re.test(msg)) return { accidental: true, hint }
    if (error.constructor === ReferenceError) return { accidental: true, hint: 'a variable is used before it exists' }
  }
  return { accidental: false }
}

function structuredCloneSafe(v) {
  try {
    return structuredClone(v)
  } catch {
    return v
  }
}

function snapshot(v) {
  if (v === null || typeof v !== 'object') return { ok: true, value: v }
  try {
    return { ok: true, value: structuredClone(v) }
  } catch {
    return { ok: false }
  }
}

function deepEqual(a, b, seen = new Map()) {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime())
  }
  if (seen.get(a) === b) return true
  seen.set(a, b)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && a.length !== b.length) return false
  if (a instanceof Map || a instanceof Set) {
    if (!(b instanceof a.constructor) || a.size !== b.size) return false
    if (a instanceof Set) return [...a].every((x) => b.has(x) || (typeof x === 'object' && x !== null))
    for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k), seen)) return false
    return true
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.hasOwn(b, k) || !deepEqual(a[k], b[k], seen)) return false
  }
  return true
}

function preview(v) {
  try {
    return inspect(v, { depth: 1, breakLength: Infinity, maxArrayLength: 3, maxStringLength: 24 })
  } catch {
    return String(typeof v)
  }
}

function errorText(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`.split('\n')[0].slice(0, 200)
  return `threw ${preview(error)}`
}

// Does the input data itself contain the token? (so printing it back is legitimate)
function containsToken(value, token) {
  if (typeof value === 'string') return value.includes(token)
  if (typeof value === 'number') return token === 'NaN' && Number.isNaN(value)
  if (Array.isArray(value)) return value.some((v) => typeof v === 'string' && v.includes(token))
  if (value && typeof value === 'object') {
    try {
      return Object.values(value).some((v) => typeof v === 'string' && v.includes(token))
    } catch {
      return false
    }
  }
  return false
}

function suspiciousOutput(result, args) {
  const strings = []
  if (typeof result === 'string') strings.push(result)
  else if (result && typeof result === 'object' && !Array.isArray(result) && Object.getPrototypeOf(result) === Object.prototype) {
    for (const v of Object.values(result)) if (typeof v === 'string') strings.push(v)
  }
  for (const token of ['[object Object]', 'undefined', 'NaN']) {
    if (strings.some((s) => s.includes(token)) && !args.some((a) => containsToken(a, token))) {
      const hint = {
        '[object Object]': 'an object is being turned into a string; format the field you meant',
        undefined: 'a missing value is being printed; add a fallback',
        NaN: 'a number became NaN before being printed; validate with Number.isFinite()',
      }[token]
      return { message: `output contains "${token}"`, hint }
    }
  }
  return null
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    // Not unref'd on purpose: a hung promise alone doesn't keep Node alive, and the
    // process would exit mid-probe. The timer is always cleared once the race settles.
    timer = setTimeout(() => reject(Object.assign(new Error(`did not settle within ${ms}ms`), { railguardTimeout: true })), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const PROTO_BEFORE = () => new Set(Object.getOwnPropertyNames(Object.prototype))

async function runCase(fn, args, opts) {
  const snaps = opts.mutation ? args.map(snapshot) : []
  const protoBefore = PROTO_BEFORE()
  let result
  let thrown
  let didThrow = false
  try {
    result = fn(...args)
    if (result && typeof result.then === 'function') result = await withTimeout(result, opts.timeout)
  } catch (e) {
    didThrow = true
    thrown = e
  }

  // Prototype pollution: detect and clean up so later cases aren't affected.
  const added = Object.getOwnPropertyNames(Object.prototype).filter((k) => !protoBefore.has(k))
  if (added.length) {
    for (const k of added) delete Object.prototype[k]
    return { status: 'failed', kind: 'pollution', message: `polluted Object.prototype with "${added.join('", "')}"`, hint: 'never merge/assign keys like "__proto__" from user input; use Object.hasOwn and skip __proto__/constructor/prototype' }
  }

  if (didThrow) {
    if (thrown && thrown.railguardTimeout) {
      return { status: 'failed', kind: 'timeout', message: thrown.message, hint: 'an awaited promise never resolved for this input' }
    }
    if (opts.allow?.(thrown, args)) return { status: 'rejected', kind: 'allowed', message: errorText(thrown) }
    const { accidental, hint } = classify(thrown)
    if (accidental || opts.strict) {
      return { status: 'failed', kind: accidental ? 'crash' : 'throws', message: errorText(thrown), hint: hint ?? 'the function throws for this input' }
    }
    return { status: 'rejected', kind: 'rejected', message: errorText(thrown) }
  }

  if (typeof result === 'number' && Number.isNaN(result) && !args.some((a) => typeof a === 'number' && Number.isNaN(a))) {
    return { status: 'failed', kind: 'nan', message: 'returned NaN', hint: 'validate numeric input with Number.isFinite() or return a fallback' }
  }
  if (result instanceof Date && Number.isNaN(result.getTime()) && !args.some((a) => a instanceof Date && Number.isNaN(a.getTime()))) {
    return { status: 'failed', kind: 'invalid-date', message: 'returned an Invalid Date', hint: 'check isNaN(date.getTime()) before returning' }
  }
  const sus = suspiciousOutput(result, args)
  if (sus) return { status: 'failed', kind: 'output', message: sus.message, hint: sus.hint }

  if (opts.mutation) {
    for (let i = 0; i < args.length; i++) {
      if (snaps[i]?.ok && !deepEqual(snaps[i].value, args[i])) {
        return { status: 'failed', kind: 'mutation', message: `changed argument #${i + 1} in place`, hint: 'copy the argument before changing it (structuredClone or spread), or pass { mutation: false } if this is intended' }
      }
    }
  }

  if (opts.invariant) {
    let holds
    try {
      holds = opts.invariant(result, args)
    } catch (e) {
      holds = false
    }
    if (holds === false) return { status: 'failed', kind: 'invariant', message: `invariant failed (returned ${preview(result)})`, hint: 'the result broke the rule you gave in `invariant`' }
  }
  return { status: 'passed' }
}

/**
 * Probe a function with edge-case inputs.
 *
 * One argument is varied at a time; the others keep their `sample` value.
 * Accidental crashes (TypeError "Cannot read properties of undefined", RangeError
 * "Invalid time value", ...) are failures. Errors your function throws on purpose
 * ("email must be a string") count as "rejected", which is fine, unless `strict` is set.
 *
 * @param {Function} fn
 * @param {object} [options]
 * @param {(string | object)[]} [options.args]  e.g. ['string', 'number'] or [edge.string({ sample: 'a@b.co' })]
 * @param {(error: unknown, args: unknown[]) => boolean} [options.allow]  return true for errors that are expected
 * @param {(result: unknown, args: unknown[]) => boolean} [options.invariant]  a rule every result must satisfy
 * @param {boolean} [options.strict=false]  treat every throw as a failure
 * @param {boolean} [options.mutation=true]  flag functions that modify their arguments
 * @param {boolean} [options.wrongTypes=true]  also try null, undefined and values of the wrong type
 * @param {number} [options.timeout=2000]  ms before an async call counts as hung
 */
export async function probe(fn, options = {}) {
  if (typeof fn !== 'function') throw new TypeError('railguard: probe() needs a function')
  const opts = { strict: false, mutation: true, wrongTypes: true, timeout: 2000, ...options }
  const argSpecs = (opts.args ?? Array.from({ length: fn.length }, () => 'any')).map(toSpec)
  const name = fn.name || 'anonymous'
  const results = []

  const samples = () => argSpecs.map((s) => s.sample())
  const record = (arg, label, input, outcome) => results.push({ arg, label, input, ...outcome })

  const baseline = await runCase(fn, samples(), { ...opts, invariant: undefined, strict: true })
  if (baseline.status !== 'passed') {
    const report = makeReport(name, argSpecs, [], `the sample input ${preview(samples())} already fails (${baseline.message}). Pass a valid { sample } for each argument, e.g. edge.string({ sample: 'a@b.co' }).`)
    return report
  }

  if (argSpecs.length > 0) {
    const out = await runCase(fn, [], opts)
    record(null, 'called with no arguments', '()', out)
  }

  for (let i = 0; i < argSpecs.length; i++) {
    const s = argSpecs[i]
    const cases = [...s.cases, ...(opts.wrongTypes ? [...NULLISH, ...s.wrong] : [])]
    for (const cs of cases) {
      const args = samples()
      args[i] = cs.make()
      const input = preview(args[i])
      const out = await runCase(fn, args, opts)
      record(i, cs.label, input, out)
    }
  }
  return makeReport(name, argSpecs, results)
}

function makeReport(name, argSpecs, results, baselineError) {
  const failed = results.filter((r) => r.status === 'failed')
  const rejected = results.filter((r) => r.status === 'rejected')
  const report = {
    name,
    signature: `${name}(${argSpecs.map((s) => s.type).join(', ')})`,
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed,
    rejected,
    problems: groupFailures(failed),
    results,
    baselineError,
    ok: !baselineError && failed.length === 0,
    toString() {
      return formatReport(report)
    },
  }
  return report
}

/** Failures that share an argument, kind and fix are one problem, listed once. */
export function groupFailures(failed) {
  const groups = new Map()
  for (const r of failed) {
    // Same error at the same place = same bug. "of undefined" and "of null" are one bug.
    const key = `${r.arg}|${r.kind}|${String(r.message).replace(/of (undefined|null)/, 'of nullish')}`
    const g = groups.get(key)
    if (g) g.labels.push(r.label)
    else groups.set(key, { arg: r.arg, kind: r.kind, message: r.message, hint: r.hint, labels: [r.label] })
  }
  return [...groups.values()]
}

function joinLabels(labels) {
  const WRONG = 'wrong type: '
  const wrong = labels.filter((l) => l.startsWith(WRONG)).map((l) => l.slice(WRONG.length))
  const rest = labels.filter((l) => !l.startsWith(WRONG))
  const parts = rest.slice(0, 6)
  if (rest.length > 6) parts.push(`+${rest.length - 6} more`)
  if (wrong.length) parts.push(`${wrong.length === 1 ? 'wrong type' : 'wrong types'}: ${wrong.join(', ')}`)
  return parts.join(', ')
}

/** Human-readable report. */
export function formatReport(report) {
  const lines = [`railguard probe · ${report.signature}`]
  if (report.baselineError) {
    lines.push(`  ✗ could not start: ${report.baselineError}`)
    return lines.join('\n')
  }
  const problems = groupFailures(report.failed)
  const distinct = problems.length && problems.length !== report.failed.length ? ` (${problems.length} distinct problem${problems.length === 1 ? '' : 's'})` : ''
  lines.push(`  ${report.total} cases · ${report.passed} passed · ${report.failed.length} failed${distinct} · ${report.rejected.length} rejected on purpose`)
  const multi = report.signature.includes(',')
  for (const p of problems) {
    const shown = joinLabels(p.labels)
    const prefix = p.arg === null || !multi ? '' : `arg ${p.arg + 1}: `
    lines.push('', `  ✗ ${prefix}${shown}`, `      ${p.kind}: ${p.message}`)
    if (p.hint) lines.push(`      fix: ${p.hint}`)
  }
  if (!report.failed.length) {
    lines.push(
      '',
      report.rejected.length
        ? `  ✓ no crashes. ${report.rejected.length} input(s) were rejected with your own error, which is fine.`
        : '  ✓ no crashes found'
    )
  }
  return lines.join('\n')
}

export class EdgeCaseError extends Error {
  constructor(report) {
    super(formatReport(report))
    this.name = 'EdgeCaseError'
    this.report = report
  }
}

/**
 * Like probe(), but throws an EdgeCaseError when something fails. Drop it into
 * node:test, Jest or Vitest: `test('slugify', () => assertEdges(slugify, { args: ['string'] }))`
 */
export async function assertEdges(fn, options) {
  const report = await probe(fn, options)
  if (!report.ok) throw new EdgeCaseError(report)
  return report
}

const RECORD = () => ({
  id: 1, name: 'Test User', firstName: 'Test', lastName: 'User', username: 'test', title: 'Test', email: 'test@example.com',
  role: 'user', status: 'active', price: 10, amount: 10, quantity: 2, count: 1, score: 80, createdAt: new Date('2024-06-15T12:00:00Z'),
})

/**
 * Try to find arg specs a function accepts without being told (used by `railguard probe`
 * with no --args). Tries simple values, then realistic records and lists of records.
 * @returns {Promise<object[] | null>} specs usable as `probe(fn, { args })`, or null
 */
export async function guessArgs(fn) {
  const n = Math.max(fn.length, 1)
  const candidates = [
    () => edge.string(),
    () => edge.number(),
    () => edge.object(),
    () => edge.array(),
    () => edge.object({ sample: RECORD }),
    () => edge.array({ sample: () => [RECORD(), { ...RECORD(), id: 2, name: 'second' }] }),
    () => edge.boolean(),
    () => edge.date(),
  ]
  for (const make of candidates) {
    const s = make()
    const out = await runCase(fn, Array.from({ length: n }, () => s.sample()), { strict: true, mutation: false, timeout: 1000 })
    if (out.status === 'passed') return Array.from({ length: n }, () => make())
  }
  return null
}
