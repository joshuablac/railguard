// Compile-only checks for the published .d.ts files: npm run test:types
import { guard, t, check, validate, asyncHandler, errorHandler, HttpError, probe, edge, type Infer } from 'railguard'
import { guard as guardFromSubpath } from 'railguard/env'
import { notFound } from 'railguard/express'
import { assertEdges } from 'railguard/edge'
import { scanText } from 'railguard/secrets'

const env = guard({
  PORT: t.port().default(3000),
  NODE_ENV: t.enum(['development', 'production', 'test']).default('development'),
  MONGO_URI: t.url().secret(),
  SENTRY_DSN: t.url().optional(),
  ORIGINS: t.array(t.string()).default(() => []),
  DEBUG: t.boolean(),
})

const port: number = env.PORT
const mode: 'development' | 'production' | 'test' = env.NODE_ENV
const dsn: string | undefined = env.SENTRY_DSN
const origins: string[] = env.ORIGINS
const debug: boolean = env.DEBUG
// @ts-expect-error optional values can be undefined
const dsnStrict: string = env.SENTRY_DSN
// @ts-expect-error the env object is read-only
env.PORT = 1
// @ts-expect-error typos are caught at compile time too
env.PROT
// @ts-expect-error PORT is a number
const wrong: string = env.PORT

const maybe = guardFromSubpath({ A: t.string() }, { source: {}, onError: () => null })
if (maybe !== null) {
  const a: string = maybe.A
}

const user = { name: t.string({ min: 1 }), age: t.int().optional(), tags: t.array(t.string()) }
type User = Infer<typeof user>
const u: User = { name: 'Jo', age: undefined, tags: [] }
const r = check(user, {})
if (r.ok) {
  const n: string = r.value.name
} else {
  const p: string = r.issues[0].path
}

const role = t.enum(['admin', 'student']).parse('admin')
let bad: 'admin' | 'student' = 'admin'
if (role.ok) {
  bad = role.value
  // @ts-expect-error enum values are literal types, not string
  const onlyAdmin: 'admin' = role.value
}

const mw = validate({ body: user, query: { page: t.int().default(1) } })
mw({}, {}, () => {})
const handler = asyncHandler(async (req, res, next) => {
  throw HttpError.notFound('Lesson not found')
})
const eh = errorHandler({ production: true, log: false, map: (e) => (e instanceof RangeError ? HttpError.badRequest(e.message) : undefined) })
notFound()

async function edges() {
  const report = await probe((s: string) => s.trim(), { args: ['string'], timeout: 100 })
  const ok: boolean = report.ok
  const kind: string | undefined = report.problems[0]?.kind
  await assertEdges((a: number, b: string) => a + b, { args: [edge.number({ sample: 1 }), edge.custom('x', ['', 'y'])] })
  // @ts-expect-error unknown arg type
  await probe((x: unknown) => x, { args: ['strnig'] })
}

const findings = scanText('x', { file: 'a.js' })
const line: number = findings[0]?.line ?? 0

export { port, mode, dsn, origins, debug, dsnStrict, wrong, u, bad, handler, eh, edges, line }
