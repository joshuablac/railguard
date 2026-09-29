// Tiny schema builder shared by the env guard and the Express `validate` middleware.
// Rule of the house: error messages NEVER contain the received value, so a bad
// secret can't leak into logs through a validation error.

// Registry symbols, so two installed copies of railguard (say, a global CLI and a
// local install) still recognise each other's fields.
const FAIL = Symbol.for('railguard.fail')
const BRAND = Symbol.for('railguard.field')
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'on'])
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'off'])

export class ValidationError extends Error {
  constructor(message, issues = []) {
    super(message)
    this.name = 'ValidationError'
    this.issues = issues
  }
}

export class Field {
  constructor(kind, parser, rule, extra = {}) {
    this.kind = kind
    this.rule = rule
    this.isOptional = false
    this.hasDefault = false
    this.defaultValue = undefined
    this.isSecret = false
    this.description = undefined
    this._parser = parser
    Object.assign(this, extra)
  }

  _with(patch) {
    return Object.assign(Object.create(Field.prototype), this, patch)
  }

  /** Value may be missing; it resolves to `undefined`. */
  optional() {
    return this._with({ isOptional: true })
  }

  /** Value used when missing. Pass a function to build a fresh value each time. */
  default(value) {
    return this._with({ hasDefault: true, defaultValue: value })
  }

  /** Hide this value when the env object is logged. */
  secret() {
    return this._with({ isSecret: true })
  }

  /** Human description shown in error messages and in generated .env.example files. */
  describe(text) {
    return this._with({ description: String(text) })
  }

  /**
   * Validate a value.
   * @param {unknown} input
   * @param {{ coerce?: boolean, path?: string }} [options]
   */
  parse(input, options = {}) {
    const issues = []
    const value = runField(this, input, { coerce: Boolean(options.coerce) }, options.path ?? '', issues)
    return issues.length ? { ok: false, issues } : { ok: true, value }
  }
}

function fail(issues, path, message) {
  issues.push({ path: path || '(value)', message })
  return FAIL
}

function joinPath(base, key) {
  if (typeof key === 'number') return `${base}[${key}]`
  return base ? `${base}.${key}` : String(key)
}

Field.prototype[BRAND] = true

export function isField(value) {
  return value instanceof Field || (value !== null && typeof value === 'object' && value[BRAND] === true)
}

/** Turn a plain `{ key: field }` shape into an object field. */
export function toField(schema) {
  if (isField(schema)) return schema
  if (schema && typeof schema === 'object') return t.object(schema)
  throw new TypeError('railguard: expected a railguard field (t.string(), t.object({...}), ...) or a plain object of fields')
}

/** @internal Runs a field, pushes issues, returns the parsed value (or FAIL). */
export function runField(field, input, ctx, path, issues) {
  const missing =
    input === undefined ||
    input === null ||
    (ctx.emptyIsMissing && typeof input === 'string' && input.trim() === '')
  if (missing) {
    if (field.hasDefault) {
      return typeof field.defaultValue === 'function' ? field.defaultValue() : field.defaultValue
    }
    if (field.isOptional) return undefined
    return fail(issues, path, 'is required')
  }
  return field._parser(input, ctx, path, issues)
}

function stringField({ min, max, pattern, trim = false } = {}, kind = 'string', rule = 'a string') {
  const chars = (n) => `${n} character${n === 1 ? '' : 's'}`
  const parts = []
  if (min != null && !(min === 1 && max == null)) parts.push(`at least ${chars(min)}`)
  if (max != null) parts.push(`at most ${chars(max)}`)
  const base = min === 1 && max == null && rule === 'a string' ? 'a non-empty string' : rule
  const fullRule = parts.length ? `${base} (${parts.join(', ')})` : base
  return new Field(
    kind,
    (v, ctx, path, issues) => {
      if (typeof v !== 'string') {
        if (ctx.coerce && (typeof v === 'number' || typeof v === 'boolean')) v = String(v)
        else return fail(issues, path, 'must be a string')
      }
      if (trim) v = v.trim()
      if (min != null && v.length < min) return fail(issues, path, min === 1 ? 'must not be empty' : `must be at least ${chars(min)}`)
      if (max != null && v.length > max) return fail(issues, path, `must be at most ${chars(max)}`)
      if (pattern) {
        pattern.lastIndex = 0
        if (!pattern.test(v)) return fail(issues, path, 'has an invalid format')
      }
      return v
    },
    fullRule
  )
}

function numberField({ min, max, int = false } = {}, kind = 'number', ruleOverride) {
  const noun = int ? 'an integer' : 'a number'
  let rule = noun
  if (min != null && max != null) rule = `${noun} between ${min} and ${max}`
  else if (min != null) rule = `${noun} ≥ ${min}`
  else if (max != null) rule = `${noun} ≤ ${max}`
  return new Field(
    kind,
    (v, ctx, path, issues) => {
      if (typeof v === 'string' && ctx.coerce) {
        const s = v.trim()
        if (!NUMBER_RE.test(s)) return fail(issues, path, `must be ${noun}`)
        v = Number(s)
      }
      if (typeof v !== 'number' || Number.isNaN(v)) return fail(issues, path, `must be ${noun}`)
      if (!Number.isFinite(v)) return fail(issues, path, 'must be a finite number')
      if (int && !Number.isInteger(v)) return fail(issues, path, 'must be an integer')
      if (int && !Number.isSafeInteger(v)) return fail(issues, path, 'is too large to be stored exactly (beyond Number.MAX_SAFE_INTEGER)')
      if ((min != null && v < min) || (max != null && v > max)) return fail(issues, path, `must be ${rule}`)
      return v
    },
    ruleOverride ?? rule
  )
}

export const t = {
  /** @param {{ min?: number, max?: number, pattern?: RegExp, trim?: boolean }} [opts] */
  string: (opts) => stringField(opts),

  /** @param {{ min?: number, max?: number, int?: boolean }} [opts] */
  number: (opts) => numberField(opts),

  /** @param {{ min?: number, max?: number }} [opts] */
  int: (opts = {}) => numberField({ ...opts, int: true }, 'int'),

  port: () => numberField({ min: 1, max: 65535, int: true }, 'port', 'a port number (1-65535)'),

  boolean: () =>
    new Field(
      'boolean',
      (v, ctx, path, issues) => {
        if (typeof v === 'boolean') return v
        if (ctx.coerce && typeof v === 'string') {
          const s = v.trim().toLowerCase()
          if (TRUE_WORDS.has(s)) return true
          if (FALSE_WORDS.has(s)) return false
        }
        return fail(issues, path, 'must be true or false')
      },
      'true or false'
    ),

  /** @param {readonly string[]} values */
  enum: (values) => {
    if (!Array.isArray(values) || values.length === 0) {
      throw new TypeError('railguard: t.enum() needs a non-empty array of allowed values')
    }
    const list = values.join(', ')
    return new Field(
      'enum',
      (v, ctx, path, issues) => {
        if (ctx.coerce && typeof v === 'string') v = v.trim()
        return values.includes(v) ? v : fail(issues, path, `must be one of: ${list}`)
      },
      `one of: ${list}`,
      { values: [...values] }
    )
  },

  /** @param {{ protocols?: string[] }} [opts] */
  url: ({ protocols } = {}) => {
    const allowed = protocols?.map((p) => p.replace(/:$/, '').toLowerCase())
    return new Field(
      'url',
      (v, ctx, path, issues) => {
        if (typeof v !== 'string') return fail(issues, path, 'must be a URL string')
        let parsed
        try {
          parsed = new URL(v.trim())
        } catch {
          return fail(issues, path, 'must be a valid URL')
        }
        if (allowed && !allowed.includes(parsed.protocol.slice(0, -1).toLowerCase())) {
          return fail(issues, path, `must use ${allowed.join(' or ')}`)
        }
        return v.trim()
      },
      allowed ? `a ${allowed.join('/')} URL` : 'a URL'
    )
  },

  /** @param {{ normalize?: boolean }} [opts] normalize = trim + lowercase */
  email: ({ normalize = false } = {}) =>
    new Field(
      'email',
      (v, ctx, path, issues) => {
        if (typeof v !== 'string') return fail(issues, path, 'must be an email address')
        const s = normalize ? v.trim().toLowerCase() : v
        if (s.length > 254 || !EMAIL_RE.test(s)) return fail(issues, path, 'must be a valid email address')
        return s
      },
      'an email address'
    ),

  json: () =>
    new Field(
      'json',
      (v, ctx, path, issues) => {
        if (typeof v !== 'string' || !ctx.coerce) return v
        try {
          return JSON.parse(v)
        } catch {
          return fail(issues, path, 'must be valid JSON')
        }
      },
      'JSON'
    ),

  /**
   * @param {Field} item
   * @param {{ min?: number, max?: number }} [opts]
   */
  array: (item, { min, max } = {}) => {
    if (!isField(item)) throw new TypeError('railguard: t.array() needs a field, e.g. t.array(t.string())')
    return new Field(
      'array',
      (v, ctx, path, issues) => {
        if (ctx.coerce && typeof v === 'string') v = v.trim() === '' ? [] : v.split(',').map((s) => s.trim())
        if (!Array.isArray(v)) return fail(issues, path, 'must be an array')
        if (min != null && v.length < min) return fail(issues, path, `must have at least ${min} items`)
        if (max != null && v.length > max) return fail(issues, path, `must have at most ${max} items`)
        const out = []
        let bad = false
        for (let i = 0; i < v.length; i++) {
          const r = runField(item, v[i], ctx, joinPath(path, i), issues)
          if (r === FAIL) bad = true
          else out.push(r)
        }
        return bad ? FAIL : out
      },
      `a list of ${item.rule}`
    )
  },

  /**
   * Unknown keys are dropped by default ("strip"), which blocks mass-assignment
   * attacks like sending `{ "role": "admin" }` to a sign-up route.
   * @param {Record<string, Field>} shape
   * @param {{ unknown?: 'strip' | 'reject' | 'keep' }} [opts]
   */
  object: (shape, { unknown = 'strip' } = {}) => {
    if (!shape || typeof shape !== 'object') throw new TypeError('railguard: t.object() needs a shape object')
    for (const [key, f] of Object.entries(shape)) {
      if (!isField(f)) throw new TypeError(`railguard: "${key}" is not a railguard field`)
    }
    return new Field(
      'object',
      (v, ctx, path, issues) => {
        if (ctx.coerce && typeof v === 'string') {
          try {
            v = JSON.parse(v)
          } catch {
            return fail(issues, path, 'must be an object')
          }
        }
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(issues, path, 'must be an object')
        const out = {}
        let bad = false
        for (const [key, f] of Object.entries(shape)) {
          const r = runField(f, Object.hasOwn(v, key) ? v[key] : undefined, ctx, joinPath(path, key), issues)
          if (r === FAIL) bad = true
          else if (r !== undefined) out[key] = r
        }
        for (const key of Object.keys(v)) {
          if (Object.hasOwn(shape, key)) continue
          if (unknown === 'reject') {
            fail(issues, joinPath(path, key), 'is not allowed')
            bad = true
          } else if (unknown === 'keep' && !UNSAFE_KEYS.has(key)) {
            out[key] = v[key]
          }
        }
        return bad ? FAIL : out
      },
      'an object',
      { shape }
    )
  },

  /** Accept anything that is present. */
  any: () => new Field('any', (v) => v, 'any value'),
}

/**
 * Validate `input` against a field or a `{ key: field }` shape.
 * @returns {{ ok: true, value: any } | { ok: false, issues: {path: string, message: string}[] }}
 */
export function check(schema, input, { coerce = false } = {}) {
  return toField(schema).parse(input, { coerce })
}

export { FAIL as _FAIL }
