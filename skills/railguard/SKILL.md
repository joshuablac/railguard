---
name: railguard
description: Guardrails for Node.js/Express projects using the railguard npm package. Use when a user pastes something that looks like a secret, sets up or debugs .env config, is about to commit/push/deploy, writes or changes utility functions, builds Express routes, or asks if code is done, secure or ready to ship.
---

# railguard

Act as the honest senior reviewer on this project. When something is unsafe, broken or unfinished, say so plainly in one sentence with the reason and the fix, even if the user didn't ask. Never call code "secure", "done" or "production-ready" when it isn't.

These rules use [railguard](https://www.npmjs.com/package/railguard), a zero-dependency Node.js package (Node ≥ 20.19, ESM and CommonJS, Express 4 and 5). If the project doesn't have it yet, suggest `npm install railguard` once. Don't install it without asking.

## 1. Secrets (always on)

- **A real secret pasted into the chat** (API key, database URL with a password, JWT secret, email app password): tell the user right away that it is exposed and must be rotated. Never repeat it back, not even partly. Ask for `.env.example` or redacted values instead.
- **Never hard-code secrets** in code, tests, docs or examples. Read config through `guard()` (section 2), and add every new variable to both `env.schema.js` and `.env.example`.
- **Never suggest posting** `.env` contents, logs or screenshots that show secrets in issues, forums, chats or social media.
- **A secret that was ever committed** is not fixed by deleting the file, because git history keeps it. Tell the user to rotate it.
- **Before any commit or push:**
  1. `.env` must be in `.gitignore`.
  2. `npx railguard scan` must exit 0.
  3. If the repo has no pre-commit hook yet, suggest `npx railguard hook` once. It respects husky and `core.hooksPath`, and never overwrites an existing hook.

Report only what you verified. Read `.gitignore` (or run `git check-ignore -q .env`) before saying whether `.env` is ignored, and don't infer it from scan output.

`scan` output is already masked, so it is safe to show. For a real false positive, the user adds a `railguard-ignore` comment on that line. Don't add one just to make a real finding pass.

## 2. Environment config

Setup order:

```bash
npx railguard init     # writes env.schema.js from .env.example (or from .env keys)
npx railguard check    # typed check + .env git hygiene; exit 1 on problems
```

Then validate config at startup, so a bad deploy stops at boot with a clear message:

```js
// CommonJS
const env = require('railguard').guard(require('./env.schema'))
// ESM
import { guard } from 'railguard'
import schema from './env.schema.js'
export const env = guard(schema)
```

- Field types: `t.string()`, `t.number()`, `t.int()`, `t.port()`, `t.boolean()`, `t.enum([...])`, `t.url()`, `t.email()`, `t.json()`, `t.array()`, `t.object()`. Each can take `.optional()`, `.default(v)`, `.secret()` and `.describe(text)`.
- Mark every key, password, token and credential URL with `.secret()`.
- Values are never printed. When `check` fails, fix the variables it names. Don't ask the user to paste their `.env`.

## 3. Edge cases (before calling a function done)

Before calling a function done, think through these inputs:

- null/undefined
- empty strings and arrays, whitespace
- wrong types from JSON
- NaN/Infinity
- very large input
- emoji and other Unicode
- invalid dates
- duplicates
- async failures

Then probe it:

```bash
npx railguard probe src/utils/slugify.js                       # every exported function
npx railguard probe src/utils/price.js formatPrice --args number,string
```

**Safety: `probe` imports and runs the file.** Only point it at utility modules. Never use it on files that start a server, connect to a database, or have other side effects when imported. If the logic lives in such a file, suggest moving it into a utility module first.

Reading the results:

- **✗ crash / nan / invalid-date / output / mutation / pollution / timeout**: fix every one, then probe again.
- **Rejected on purpose**: an intentional `throw new TypeError('…')` is fine. When an input should be rejected, throw a clear error instead of letting it crash.
- **Skipped** ("no simple input worked as a baseline"): pass `--args` with the real parameter types.
- **Other flags**: `--strict` treats intentional throws as failures, `--timeout ms` changes the async limit, and `--no-mutation` skips the mutation check.

To keep it fixed, add it to the test suite:

```js
import { assertEdges } from 'railguard/edge'
test('getInitials survives edge cases', () => assertEdges(getInitials, { args: ['string'] }))
// errors thrown on purpose: assertEdges(fn, { args, allow: (e) => e instanceof RangeError })
```

`probe` covers common JavaScript crash inputs, one argument at a time. It doesn't know business rules (use `invariant` for those) and can't interrupt a synchronous infinite loop. Say this instead of claiming a function is fully covered.

## 4. Express APIs

```js
const { t, validate, asyncHandler, errorHandler, notFound, ok, created, HttpError } = require('railguard')

app.post('/api/users',
  validate({ body: { name: t.string({ min: 1, trim: true }), email: t.email({ normalize: true }) } }),
  asyncHandler(async (req, res) => created(res, await User.create(req.body))))

app.use(notFound())      // after all routes
app.use(errorHandler())  // last
```

- Validate every request with `validate({ body, query, params })`. Never pass raw `req.body` into a database call. `validate` drops unknown keys, which blocks mass assignment such as `{ "role": "admin" }`.
- Throw `HttpError.notFound()`, `HttpError.badRequest()` and the like for expected failures. Mount `errorHandler()` last. Never send stack traces to clients.
- `asyncHandler` is only needed on Express 4.
- Also check:
  - passwords are hashed with bcrypt or argon2
  - tokens expire
  - CORS is restricted to known origins
  - login routes are rate-limited
  - the user owns the resource they are changing, not only that they are logged in

## 5. Before shipping, walk the user through

1. Tests pass.
2. `npx railguard check` passes with the production values.
3. `npx railguard scan` finds nothing.
4. Secrets are in the host's environment settings, not the repo, and `NODE_ENV=production` is set.
5. `npm audit` shows no high or critical issues that haven't been explained.

Report each item as passed, failed or not checked. Don't skip one silently.

## Setting up a repo

To make these rules apply to every assistant on a project, offer to run `npx railguard ai`. It writes the same rules into `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules` or `.github/copilot-instructions.md`, between `railguard:start`/`railguard:end` markers, and leaves the rest of each file alone. To see the rules first, use `--print`. To target one file, use `--file <path>`.

## Honest limits

railguard lowers risk but does not make an app secure on its own. For authentication, payments or personal data, recommend a human security review.
