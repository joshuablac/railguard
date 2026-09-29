# railguard

**Guardrails for Node.js apps, whether a person or an AI wrote the code.**

[Website](https://joshuablac.github.io/railguard/) · [npm](https://www.npmjs.com/package/railguard) · [Changelog](./CHANGELOG.md)

One install, three guards, zero dependencies:

| Guard | What it stops |
|---|---|
| **Env + secret guard** | Apps booting with a missing or mistyped `.env`. Database passwords, API keys and `.env` files getting committed to git. |
| **Express toolkit** | `try/catch` boilerplate in every route, inconsistent error JSON, stack traces leaking to users, raw Mongoose/JWT errors reaching the client. |
| **Edge-case prober** | Functions that crash on `null`, `""`, `NaN`, `[]`, emoji, invalid dates, `__proto__` payloads and other inputs nobody tested. |

```bash
npm install railguard
```

```bash
npx railguard init                  # env.schema.js from your .env.example
npx railguard check                 # typed env check + .env git hygiene
npx railguard hook                  # block commits that contain secrets
npx railguard probe src/utils.js    # throw edge cases at every exported function
```

Node.js ≥ 20.19. Works with `import` and `require`, Express 4 and 5, and TypeScript (types included).

---

## 1. Env + secret guard

### Fail fast on a bad `.env`

```js
// env.schema.js  (npx railguard init writes this for you)
const { t } = require('railguard')

module.exports = {
  NODE_ENV: t.enum(['development', 'production', 'test']).default('development'),
  PORT: t.port().default(5000),
  MONGO_DB: t.url().describe('MongoDB connection string'),
  JWT_SECRET: t.string({ min: 32 }).secret(),
  SENDER_EMAIL: t.email(),
  EMAIL_PASS: t.string({ min: 1 }).secret(),
  CLIENT_URL: t.url(),
}
```

```js
// server.js
const { guard } = require('railguard')
const env = guard(require('./env.schema'))   // loads .env, validates, or stops the app

mongoose.connect(env.MONGO_DB)               // env.PORT is a number, not "5000"
app.listen(env.PORT)
```

When something is wrong, you get **every** problem at once. Values are never printed, so a bad secret can't leak into your logs. The same check runs from the command line:

```
$ npx railguard check
railguard check
  railguard: 3 environment variables need attention

  ✗ PORT        must be an integer
  ✗ JWT_SECRET  is required, expected a string (at least 32 characters)
  ✗ CLIENT_URL  is required, expected a URL

  Set them in .env for local work, or in your host’s environment settings in production.

3 problems found.
```

`guard()` throws the same report when the app starts, so a broken deploy stops at boot with a clear message instead of failing on the first request.

The `env` object is also:

- **Typed**: `"3000"` becomes `3000`, `"false"` becomes `false`. In TypeScript, `env.PORT` is a `number` and `env.NODE_ENV` is `'development' | 'production' | 'test'`.
- **Typo-proof**: `env.MONGO_URL` (instead of `MONGO_DB`) throws instead of quietly returning `undefined`.
- **Frozen**: nothing can change your config at runtime.
- **Safe to log**: `console.log(env)` prints `JWT_SECRET: '[secret]'`.

For URLs that come from users, restrict the scheme with `t.url({ protocols: ['https'] })`, which blocks `javascript:` links.

Field types: `t.string()`, `t.number()`, `t.int()`, `t.port()`, `t.boolean()`, `t.enum([...])`, `t.url()`, `t.email()`, `t.json()`, `t.array(field)`, `t.object(shape)`, `t.any()`, each with `.optional()`, `.default(v)`, `.secret()` and `.describe(text)`.

### Catch secrets before they reach GitHub

```bash
npx railguard scan          # whole project (respects .gitignore)
npx railguard hook          # adds a pre-commit hook: every commit is scanned
```

```
$ npx railguard scan
railguard scan · 4 files checked

  ✗ config.js:1:25  Database URL with a password
      mongodb+srv://demo:********@

1 problem. Move secrets into .env (git-ignored) and read them with process.env.
Anything that was ever pushed is public: rotate it, even after deleting it.
False positive? Add a "railguard-ignore" comment on that line.
```

It detects database URLs with passwords (MongoDB, Postgres, MySQL, Redis, AMQP), Gmail-style app passwords, AWS keys, GitHub tokens, Stripe keys, OpenAI/Anthropic keys, Google API keys, Slack tokens, SendGrid keys, JWTs, private keys, and hard-coded `password`/`secret`/`token` values. It also flags `.env` files that aren't git-ignored, or that are **still tracked** after you added them to `.gitignore`, a common mistake.

Hard-coded values assigned to names like `password`, `secret` or `token` are flagged differently by file type. In `.env`, YAML and other config files, any real value counts. In code, only quoted values that look generated count: 8+ characters with letters and digits. That keeps parser names like `lastSignificantToken = "?InterpolationInJSX"` quiet. Markdown is checked only by the specific detectors above. Across 9,238 files from real `node_modules` folders, the scanner reported one finding, a token one package really did publish.

Every finding is masked. Placeholders like `<password>`, `your-api-key` and `process.env.X` are ignored. For a false positive, put `railguard-ignore` in a comment on that line.

The hook respects `core.hooksPath` (so it works with husky) and never overwrites an existing hook. If you already have one, it prints the line to add.

---

## 2. Express toolkit

```js
const express = require('express')
const { t, validate, asyncHandler, errorHandler, notFound, ok, created, HttpError } = require('railguard')

const app = express()
app.use(express.json())

app.post('/api/users',
  validate({ body: { name: t.string({ min: 1, trim: true }), email: t.email({ normalize: true }) } }),
  asyncHandler(async (req, res) => {
    const user = await User.create(req.body)   // req.body has only name + email
    created(res, user)
  })
)

app.get('/api/lessons/:id', asyncHandler(async (req, res) => {
  const lesson = await Lesson.findById(req.params.id)
  if (!lesson) throw HttpError.notFound('Lesson not found')
  ok(res, lesson)
}))

app.use(notFound())       // unknown routes → 404 JSON
app.use(errorHandler())   // every error → one JSON shape
```

**One response shape everywhere:**

```json
{ "success": true,  "data": { "id": "42" } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Validation failed",
                               "details": [{ "path": "body.email", "message": "must be a valid email address" }] } }
```

**It understands the errors a MERN app actually throws**, with no dependency on those libraries:

| Thrown | Response |
|---|---|
| `HttpError.notFound('Lesson not found')` | 404 `NOT_FOUND` |
| Mongoose `ValidationError` | 400 `VALIDATION_ERROR` + every field |
| Mongoose `CastError` (bad ObjectId) | 400 `INVALID_ID` |
| MongoDB duplicate key `E11000` | 409 `DUPLICATE`, e.g. "email already exists" (the value is not echoed) |
| jsonwebtoken `TokenExpiredError` / `JsonWebTokenError` | 401 `TOKEN_EXPIRED` / `INVALID_TOKEN` |
| Broken JSON body / body too large | 400 `INVALID_JSON` / 413 `PAYLOAD_TOO_LARGE` |
| multer `LIMIT_FILE_SIZE` | 413 |
| Anything else | 500. The real message and stack when `NODE_ENV` is `development`/`test`; otherwise `"Something went wrong"` |

**`validate()`** checks `params`, `query` and `body` and reports every problem in one 400. Query and params are coerced (`?page=2` → `2`). Unknown body keys are **dropped**, so `{ "role": "admin" }` can't sneak into `User.create(req.body)` (mass assignment). Parsed values are also on `req.valid`.

**`asyncHandler()`**: Express 5 already forwards async errors, so you can skip it there. On Express 4 it saves a `try/catch` in every route.

`errorHandler({ log, production, map })`: `log` is called for 5xx (default `console.error`, `false` to disable), `production` hides 5xx messages and stacks and is on unless `NODE_ENV` is `development` or `test` (so a host that leaves `NODE_ENV` unset never leaks a stack), and `map(err)` converts your own error types into an `HttpError`.

---

## 3. Edge-case prober

AI assistants (and tired humans) write code for the happy path. `probe` calls your function with the inputs that usually break JavaScript and tells you what crashed and how to fix it.

```bash
npx railguard probe src/utils.js            # every exported function, argument types guessed
npx railguard probe src/price.js format --args number,string
```

```
$ npx railguard probe examples/utils.js        (output trimmed)

railguard probe · getInitials(string)
  36 cases · 23 passed · 13 failed (4 distinct problems) · 0 rejected on purpose

  ✗ empty string, single space, whitespace only, leading/trailing spaces
      crash: TypeError: Cannot read properties of undefined (reading 'toUpperCase')
      fix: add a null/undefined check or a default value

  ✗ undefined, null
      crash: TypeError: Cannot read properties of undefined (reading 'split')
      fix: add a null/undefined check or a default value
  …

railguard probe · average(array)
  22 cases · 6 passed · 16 failed (4 distinct problems) · 0 rejected on purpose

  ✗ empty array, [undefined], [NaN], mixed types, nested arrays
      nan: returned NaN
      fix: validate numeric input with Number.isFinite() or return a fallback
  …

railguard probe · formatDate(date)
  ✗ Invalid Date
      crash: RangeError: Invalid time value
      fix: check isNaN(date.getTime()) before formatting a date
  …
```

Each of these functions looks fine at a glance. [`examples/utils.js`](./examples/utils.js) also has the fixed `getInitialsSafe`, which passes all 36 cases.

### In your tests (node:test, Jest, Vitest)

```js
import { test } from 'node:test'
import { assertEdges, edge } from 'railguard/edge'
import { getInitials, formatPrice } from '../src/utils.js'

test('getInitials survives edge cases', () => assertEdges(getInitials, { args: ['string'] }))

test('formatPrice', () =>
  assertEdges(formatPrice, {
    args: ['number', edge.custom('USD', ['', 'usd', 'NGN'])],
    allow: (err) => err instanceof RangeError,        // errors you throw on purpose
    invariant: (out) => typeof out === 'string',       // a rule every result must follow
  }))
```

### What it tries and what it catches

- **Strings:** `""`, whitespace, 10k chars, emoji and ZWJ sequences, lone surrogates, RTL, null bytes, `<script>`, SQL injection, `../../etc/passwd`, malformed `%E0%A4%A`, `"__proto__"`, `"null"`, `"NaN"`, `"false"`…
- **Numbers:** `0`, `-0`, `NaN`, `±Infinity`, `0.1+0.2`, 2³¹, beyond `MAX_SAFE_INTEGER`, `5e-324`, `1e21`…
- **Arrays, objects, dates:** empty, sparse, frozen, 10k items, circular, 1000-deep, null-prototype, `{ "__proto__": … }`, `{ $gt: "" }`, `Map`, Invalid Date, leap day, year 9999…
- **Wrong types:** `null`, `undefined`, numbers for strings, `"42"` for numbers, `BigInt`, functions, and calling with no arguments.

| It reports | Example |
|---|---|
| **crash** | `TypeError: Cannot read properties of undefined`, `Invalid time value`, `Maximum call stack size exceeded`, `URI malformed`… |
| **nan / invalid-date** | returned `NaN` or an Invalid Date from valid-looking input |
| **output** | returned text containing `undefined`, `NaN` or `[object Object]` |
| **mutation** | changed the array/object it was given |
| **pollution** | wrote to `Object.prototype` (and railguard cleans it up) |
| **timeout** | an async function never settled |
| **invariant** | broke a rule you gave it |

Errors your function throws **on purpose** (`throw new TypeError('email must be a string')`) count as *rejected*, which is fine. Only accidental crashes fail, unless you pass `strict: true`.

**Honest limits:** no tool can find *every* edge case. This one covers the inputs that most often crash JavaScript, one argument at a time. It can't interrupt an infinite loop in synchronous code (JavaScript doesn't allow that), and it doesn't understand your business rules; use `invariant` for those. It **imports and runs** the file you point it at, so use it on utility modules, not files that start servers or connect to databases.

---

## Using railguard with AI coding assistants

AI tools write code fast and skip edge cases. railguard gives them, and you, a quick way to check the result. Paste this into `CLAUDE.md`, `AGENTS.md`, `.cursorrules` or `.github/copilot-instructions.md`:

```md
## Guardrails (railguard)
- Read config only through the `env` object from `guard(require('./env.schema'))`. Never read
  `process.env` directly elsewhere, and never hard-code secrets.
- When adding an environment variable, add it to `env.schema.js` and `.env.example`.
- Express: validate input with `validate({ body, query, params })`, throw `HttpError.*` for expected
  failures, and let `errorHandler()` format errors. Don't write try/catch just to send a 500.
- After writing or changing a utility function, run `npx railguard probe <file> <exportName>` and fix
  every ✗ before finishing.
- Before committing, `npx railguard scan` must exit 0.
```

The package also ships [`llms.txt`](./llms.txt): a compact, complete API reference written for language models.

---

## API

```js
import { guard, t, envExample } from 'railguard/env'
import { validate, errorHandler, notFound, asyncHandler, HttpError, ok, created, normalizeError } from 'railguard/express'
import { probe, assertEdges, edge } from 'railguard/edge'
import { scanText, scanFiles, scanStaged, checkEnvFiles, installHook } from 'railguard/secrets'
// or everything from 'railguard'
```

| Function | Returns |
|---|---|
| `guard(schema, { source?, file?, onError? })` | frozen, typed env object; throws `EnvError` listing every issue |
| `envExample(schema)` | text of a `.env.example` (secret defaults omitted) |
| `check(schema, input, { coerce? })` | `{ ok: true, value }` or `{ ok: false, issues }` |
| `validate({ params?, query?, body? })` | Express middleware |
| `errorHandler(options?)` / `notFound()` | Express middleware |
| `probe(fn, options)` | `Promise<report>`: `report.ok`, `report.problems`, `String(report)` |
| `assertEdges(fn, options)` | like `probe`, throws `EdgeCaseError` on failure |
| `scanText(text, { file })` | findings (masked) |
| `scanFiles({ cwd, paths })` / `scanStaged({ cwd })` | `{ findings, scanned }` |

## FAQ

**Why not zod / envalid / gitleaks / fast-check?** They're excellent, and you should reach for them when you outgrow this. railguard is the zero-config first line: one small dependency-free package that covers the mistakes that bite most Node/Express projects, with output a beginner can act on.

**Does `guard()` replace dotenv?** Yes. It reads `.env` itself (real environment variables win) and fills `process.env` for code that still reads it. Keeping dotenv also works.

**Can I use it in CI?** `railguard check` and `railguard scan` exit with code 1 on problems.

## License

MIT © Joshua ([@joshuablac](https://github.com/joshuablac))
