#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { guard, envExample, readEnvFile, EnvError } from '../src/env.js'
import { scanFiles, scanStaged, checkEnvFiles, installHook, isGitRepo } from '../src/secrets.js'
import { probe, guessArgs, formatReport } from '../src/edge.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const useColor = process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== '0' : process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s))
const red = paint('31')
const green = paint('32')
const yellow = paint('33')
const dim = paint('2')
const bold = paint('1')

const HELP = `${bold('railguard')} ${pkg.version}: guardrails for Node.js apps

${bold('Usage')}
  railguard check   [--schema env.schema.js] [--env .env]   validate your env; check .env is git-ignored
  railguard scan    [paths...] [--staged]                    find leaked secrets (exit 1 if any)
  railguard hook                                             install a git pre-commit hook that runs scan --staged
  railguard init                                             write env.schema.js from your .env.example
  railguard example [--schema env.schema.js]                 print a .env.example generated from your schema
  railguard probe   <file> [export] [--args string,number] [--strict] [--timeout ms] [--no-mutation]
                                                             throw edge cases at exported functions

${bold('Examples')}
  npx railguard init && npx railguard check
  npx railguard hook
  npx railguard probe src/utils/slugify.js
  npx railguard probe src/utils/price.js formatPrice --args number,string

Docs: ${pkg.homepage}`

function parseArgs(argv) {
  const positional = []
  const flags = {}
  const valued = new Set(['schema', 'env', 'args', 'timeout'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s)
      if (v !== undefined) flags[k] = v
      else if (valued.has(k)) flags[k] = argv[++i]
      else flags[k] = true
    } else if (a === '-h') flags.help = true
    else if (a === '-v') flags.version = true
    else positional.push(a)
  }
  return { positional, flags }
}

const SCHEMA_FILES = ['env.schema.js', 'env.schema.mjs', 'env.schema.cjs']

async function loadSchema(flag) {
  const file = flag ?? SCHEMA_FILES.find((f) => existsSync(f))
  if (!file) return null
  const full = resolve(file)
  if (!existsSync(full)) throw new Error(`schema file not found: ${file}`)
  const mod = await import(pathToFileURL(full).href)
  const schema = mod.default?.schema ?? mod.schema ?? mod.default ?? mod
  return { file, schema }
}

function printEnvHygiene() {
  const problems = checkEnvFiles(process.cwd())
  for (const p of problems) console.log(`  ${p.level === 'error' ? red('✗') : yellow('!')} ${p.message}`)
  return problems.filter((p) => p.level === 'error').length
}

async function cmdCheck(flags) {
  console.log(bold('railguard check'))
  let errors = printEnvHygiene()
  const loaded = await loadSchema(flags.schema)
  if (loaded) {
    const source = flags.env ? readEnvFile(flags.env) : { ...readEnvFile('.env'), ...process.env }
    const result = guard(loaded.schema, { source, file: false, onError: (e) => e })
    if (result instanceof EnvError) {
      errors += result.issues.length
      console.log(result.message.split('\n').map((l) => (l.includes('✗') ? l.replace('✗', red('✗')) : `  ${l}`)).join('\n'))
    } else {
      console.log(`  ${green('✓')} ${Object.keys(loaded.schema).length} variables match ${loaded.file}`)
    }
  } else if (existsSync('.env.example')) {
    const example = readEnvFile('.env.example')
    const env = flags.env ? readEnvFile(flags.env) : { ...readEnvFile('.env'), ...process.env }
    const missing = Object.keys(example).filter((k) => env[k] === undefined || String(env[k]).trim() === '')
    const localOnly = Object.keys(readEnvFile(flags.env ?? '.env')).filter((k) => !(k in example))
    for (const k of missing) console.log(`  ${red('✗')} ${k} is in .env.example but missing or empty in your environment`)
    for (const k of localOnly) console.log(`  ${yellow('!')} ${k} is in .env but not in .env.example, so teammates won't know it exists`)
    if (missing.length) errors++
    else console.log(`  ${green('✓')} every key in .env.example is set`)
    console.log(dim('  Tip: run "railguard init" to get typed checks (ports, URLs, booleans) instead of presence only.'))
  } else {
    console.log(`  ${yellow('!')} no env.schema.js or .env.example found. Run "railguard init" to create a schema.`)
  }
  if (errors) console.log(red(`\n${errors} problem${errors === 1 ? '' : 's'} found.`))
  return errors ? 1 : 0
}

async function cmdScan(positional, flags) {
  const staged = Boolean(flags.staged)
  if (staged && !isGitRepo()) {
    console.error(red('railguard: --staged needs a git repository'))
    return 2
  }
  const { findings, scanned } = staged ? scanStaged() : scanFiles({ paths: positional })
  const hygiene = staged ? [] : checkEnvFiles(process.cwd()).filter((p) => p.level === 'error')
  console.log(`${bold('railguard scan')} ${dim(`· ${scanned} ${staged ? 'staged ' : ''}file${scanned === 1 ? '' : 's'} checked`)}`)
  for (const f of findings) {
    const where = f.line ? `${f.file}:${f.line}:${f.column}` : f.file
    console.log(`\n  ${red('✗')} ${bold(where)}  ${f.title}`)
    console.log(`      ${dim(f.preview)}`)
  }
  for (const p of hygiene) console.log(`\n  ${red('✗')} ${p.message}`)
  const total = findings.length + hygiene.length
  if (!total) {
    console.log(`  ${green('✓')} no secrets found`)
    return 0
  }
  console.log(
    `\n${red(`${total} problem${total === 1 ? '' : 's'}.`)} Move secrets into .env (git-ignored) and read them with process.env.` +
      `\nAnything that was ever pushed is public: rotate it, even after deleting it.` +
      dim(`\nFalse positive? Add a "railguard-ignore" comment on that line.`) +
      (staged ? dim('\nTo commit anyway (not recommended): git commit --no-verify') : '')
  )
  return 1
}

function cmdHook() {
  const r = installHook(process.cwd())
  if (r.status === 'installed') console.log(`${green('✓')} pre-commit hook installed at ${r.path}\n  Every commit is now scanned for secrets and .env files.`)
  else if (r.status === 'already-installed') console.log(`${green('✓')} railguard is already in ${r.path}`)
  else console.log(`${yellow('!')} ${r.path} already exists, so it was left alone. Add this line to it:\n\n  ${r.line}\n`)
  return 0
}

function inferField(key, value, fromExample) {
  const k = key.toUpperCase()
  const v = (value ?? '').trim()
  const secret = /(SECRET|PASSWORD|PASSWD|PASS$|_PASS_|TOKEN|API_?KEY|PRIVATE|CREDENTIAL)/.test(k) || /:\/\/[^\s/@:]+:[^\s/@]+@/.test(v)
  let f
  if (k === 'NODE_ENV') return `t.enum(['development', 'production', 'test']).default('development')`
  if (k === 'PORT' || k.endsWith('_PORT')) f = fromExample && /^\d+$/.test(v) ? `t.port().default(${v})` : 't.port()'
  else if (/^(true|false)$/i.test(v)) f = 't.boolean()'
  else if (/^-?\d+$/.test(v) && !secret) f = 't.int()'
  else if (/^-?\d*\.\d+$/.test(v) && !secret) f = 't.number()'
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /_(URL|URI)$/.test(k) || /^(MONGO|DATABASE|DB)(_|$)/.test(k)) f = 't.url()'
  else if (/EMAIL/.test(k) && !secret) f = 't.email()'
  else f = 't.string({ min: 1 })'
  return secret ? `${f}.secret()` : f
}

function nearestPackageType(dir) {
  let d = resolve(dir)
  for (;;) {
    const p = join(d, 'package.json')
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8')).type === 'module' ? 'module' : 'commonjs'
      } catch {
        return 'commonjs'
      }
    }
    const up = dirname(d)
    if (up === d) return 'commonjs'
    d = up
  }
}

function cmdInit() {
  const target = SCHEMA_FILES.find((f) => existsSync(f))
  if (target) {
    console.log(`${yellow('!')} ${target} already exists, so it was left alone.`)
    return 0
  }
  const fromExample = existsSync('.env.example')
  const file = fromExample ? '.env.example' : '.env'
  const source = readEnvFile(file)
  // Keep the order of the original file (parseEnv does not guarantee it).
  const ordered = [...readFileSync(file, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/gm)].map((m) => m[1])
  const keys = [...new Set([...ordered.filter((k) => k in source), ...Object.keys(source)])]
  if (!keys.length) {
    console.log(`${yellow('!')} no .env.example or .env found. Create one first, or write env.schema.js by hand (see README).`)
    return 1
  }
  const esm = nearestPackageType('.') === 'module'
  const body = keys.map((k) => `  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${inferField(k, source[k], fromExample)},`).join('\n')
  const text = esm
    ? `// Generated by railguard from ${fromExample ? '.env.example' : '.env (keys and value shapes only)'}. Adjust the types to taste.
// Use it at startup:  import { guard } from 'railguard'; import schema from './env.schema.js'; export const env = guard(schema)
import { t } from 'railguard'

export default {
${body}
}
`
    : `// Generated by railguard from ${fromExample ? '.env.example' : '.env (keys and value shapes only)'}. Adjust the types to taste.
// Use it at startup:  const env = require('railguard').guard(require('./env.schema'))
const { t } = require('railguard')

module.exports = {
${body}
}
`
  writeFileSync('env.schema.js', text)
  console.log(`${green('✓')} wrote env.schema.js with ${keys.length} variables (${esm ? 'ESM' : 'CommonJS'}). Next: npx railguard check`)
  return 0
}

async function cmdExample(flags) {
  const loaded = await loadSchema(flags.schema)
  if (!loaded) {
    console.error(red('railguard: no env.schema.js found. Run "railguard init" or pass --schema.'))
    return 1
  }
  process.stdout.write(envExample(loaded.schema))
  return 0
}

function isClass(fn) {
  return /^class[\s{]/.test(Function.prototype.toString.call(fn))
}

async function cmdProbe(positional, flags) {
  const [file, exportName] = positional
  if (!file) {
    console.error('Usage: railguard probe <file> [export] [--args string,number]')
    return 2
  }
  const full = resolve(file)
  if (!existsSync(full)) {
    console.error(red(`railguard: file not found: ${file}`))
    return 2
  }
  console.error(dim('railguard probe imports your file. Point it at utility modules, not ones that start servers or connect to databases.\n'))
  const mod = await import(pathToFileURL(full).href)
  const bag = { ...(mod.default && typeof mod.default === 'object' ? mod.default : {}), ...mod }
  if (typeof mod.default === 'function' && !isClass(mod.default)) bag.default = mod.default
  let targets
  if (exportName) {
    if (typeof bag[exportName] !== 'function') {
      console.error(red(`railguard: "${exportName}" is not an exported function of ${file}`))
      return 2
    }
    targets = [[exportName, bag[exportName]]]
  } else {
    targets = Object.entries(bag).filter(([, v]) => typeof v === 'function' && !isClass(v))
    if (!targets.length) {
      console.error(red(`railguard: ${file} exports no functions`))
      return 2
    }
  }
  const argTypes = typeof flags.args === 'string' ? flags.args.split(',').map((s) => s.trim()).filter(Boolean) : null
  const timeout = flags.timeout ? Number(flags.timeout) : 2000
  let failed = 0
  let unprobed = 0
  for (const [name, fn] of targets) {
    const args = argTypes ?? (await guessArgs(fn))
    if (!args) {
      console.log(`${yellow('!')} ${name}: skipped, no simple input worked as a baseline. Try --args (e.g. --args string,number).\n`)
      continue
    }
    const report = await probe(fn, { args, strict: Boolean(flags.strict), mutation: !flags['no-mutation'], timeout })
    if (report.name === 'anonymous' || report.name === 'default') {
      report.name = name
      report.signature = report.signature.replace(/^[^(]*/, name)
    }
    if (report.baselineError) unprobed++
    else if (!report.ok) failed++
    const text = formatReport(report)
      .replace(/✗/g, red('✗'))
      .replace(/✓/g, green('✓'))
      .replace(/^(railguard probe · .*)$/m, (m) => bold(m))
    console.log(text + '\n')
  }
  if (unprobed) console.log(yellow(`${unprobed} function${unprobed === 1 ? '' : 's'} could not be probed: pass --args with types that match its parameters.`))
  if (failed) {
    console.log(red(`${failed} function${failed === 1 ? '' : 's'} crashed on edge cases.`) + dim(' Fix them, or add the inputs you reject on purpose to your tests with assertEdges({ allow }).'))
  }
  return failed || unprobed ? 1 : 0
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const [command, ...rest] = positional
  if (flags.version) return console.log(pkg.version), 0
  if (flags.help || !command || command === 'help') return console.log(HELP), 0
  switch (command) {
    case 'check': return cmdCheck(flags)
    case 'scan': return cmdScan(rest, flags)
    case 'hook': return cmdHook()
    case 'init': return cmdInit()
    case 'example': return cmdExample(flags)
    case 'probe': return cmdProbe(rest, flags)
    default:
      console.error(red(`railguard: unknown command "${command}"\n`))
      console.log(HELP)
      return 2
  }
}

main().then(
  (code) => {
    process.exitCode = code ?? 0
  },
  (err) => {
    console.error(red(`railguard: ${err?.message ?? err}`))
    process.exitCode = 2
  }
)
