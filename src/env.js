import { existsSync, readFileSync } from 'node:fs'
import { inspect, parseEnv } from 'node:util'
import { ValidationError, isField, runField, t, _FAIL } from './schema.js'

export { t }

const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|PASS$|_PASS_|TOKEN|API_?KEY|PRIVATE|CREDENTIAL|SALT|DSN|_AUTH)/i
const CREDENTIAL_URL = /^[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i

// Property names that libraries probe on arbitrary objects. Reading them on the
// env object must not throw.
const PASSTHROUGH = new Set([
  'then', 'toJSON', 'toString', 'valueOf', 'constructor', 'inspect', 'asymmetricMatch',
  '$$typeof', 'nodeType', '__esModule', 'default', 'length', 'prototype', 'hasOwnProperty',
])

export class EnvError extends ValidationError {
  constructor(message, issues) {
    super(message, issues)
    this.name = 'EnvError'
  }
}

/** True when a variable should be hidden when the env object is printed. */
export function isSecretKey(key, field, value) {
  return Boolean(field?.isSecret) || SECRET_NAME.test(key) || (typeof value === 'string' && CREDENTIAL_URL.test(value))
}

/** Read a dotenv file into a plain object. Missing file → {}. */
export function readEnvFile(file) {
  if (!file || !existsSync(file)) return {}
  return { ...parseEnv(readFileSync(file, 'utf8')) }
}

function assertSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    throw new TypeError('railguard: guard() needs a schema object, e.g. guard({ PORT: t.port() })')
  }
  for (const [key, field] of Object.entries(schema)) {
    if (!isField(field)) {
      throw new TypeError(`railguard: schema.${key} is not a railguard field. Use t.string(), t.port(), t.url(), ...`)
    }
  }
}

/**
 * Validate environment variables at startup. Every problem is reported at once,
 * values are coerced ("3000" → 3000, "false" → false) and the result is a frozen,
 * typo-proof object: reading a key that is not in the schema throws.
 *
 * @param {Record<string, import('./schema.js').Field>} schema
 * @param {{ source?: Record<string, string | undefined>, file?: string | false, onError?: (error: EnvError) => any }} [options]
 */
export function guard(schema, options = {}) {
  assertSchema(schema)
  const usingProcessEnv = options.source === undefined
  let source = options.source ?? process.env

  // Like dotenv: when reading process.env, load .env underneath it (real env wins)
  // and copy the loaded values into process.env for code that still reads it directly.
  const file = options.file ?? (usingProcessEnv ? '.env' : false)
  if (file) {
    const fromFile = readEnvFile(file)
    if (usingProcessEnv) {
      for (const [k, v] of Object.entries(fromFile)) if (process.env[k] === undefined) process.env[k] = v
      source = process.env
    } else {
      source = { ...fromFile, ...source }
    }
  }

  const issues = []
  const values = {}
  for (const [key, field] of Object.entries(schema)) {
    const value = runField(field, source[key], { coerce: true, emptyIsMissing: true }, key, issues)
    if (value !== _FAIL) values[key] = value
  }

  if (issues.length) {
    const error = new EnvError(formatEnvIssues(issues, schema), issues)
    if (options.onError) return options.onError(error)
    throw error
  }

  return lockEnv(values, schema)
}

function lockEnv(values, schema) {
  Object.defineProperty(values, inspect.custom, {
    enumerable: false,
    value(depth, opts, insp = inspect) {
      const shown = {}
      for (const [k, v] of Object.entries(values)) shown[k] = isSecretKey(k, schema[k], v) && v !== undefined ? '[secret]' : v
      return `Env ${insp(shown, opts)}`
    },
  })
  Object.freeze(values)
  return new Proxy(values, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop in target || PASSTHROUGH.has(prop)) return Reflect.get(target, prop, receiver)
      throw new ReferenceError(
        `railguard: env.${prop} is not in your env schema. Check the spelling, or add ${prop} to the schema.`
      )
    },
  })
}

/** Readable, value-free summary of env problems. */
export function formatEnvIssues(issues, schema = {}) {
  const width = Math.min(28, Math.max(...issues.map((i) => i.path.length)))
  const n = issues.length
  const lines = [`railguard: ${n} environment variable${n === 1 ? '' : 's'} ${n === 1 ? 'needs' : 'need'} attention`, '']
  for (const issue of issues) {
    const field = schema[issue.path]
    let line = `  ✗ ${issue.path.padEnd(width)}  ${issue.message}`
    if (issue.message === 'is required' && field?.rule) line += `, expected ${field.rule}`
    if (field?.description) line += ` — ${field.description}`
    lines.push(line)
  }
  lines.push('', 'Set them in .env for local work, or in your host’s environment settings in production.')
  return lines.join('\n')
}

/**
 * Generate the text of a .env.example file from a schema. Secret defaults are never written.
 * @param {Record<string, import('./schema.js').Field>} schema
 */
export function envExample(schema) {
  assertSchema(schema)
  const out = ['# Generated by railguard. Copy to .env and fill in the blanks.', '']
  for (const [key, field] of Object.entries(schema)) {
    const secret = isSecretKey(key, field)
    const bits = [field.rule]
    if (field.isOptional) bits.push('optional')
    else if (!field.hasDefault) bits.push('required')
    if (secret) bits.push('secret, never commit')
    out.push(`# ${field.description ? `${field.description} — ` : ''}${bits.join(', ')}`)
    const def = field.hasDefault && !secret && typeof field.defaultValue !== 'function' ? field.defaultValue : ''
    out.push(`${key}=${def === undefined ? '' : typeof def === 'object' ? JSON.stringify(def) : def}`)
    out.push('')
  }
  return out.join('\n')
}
