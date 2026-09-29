# Changelog

## 0.1.0 (2026-09-29)

First release.

- **env**: `guard()` validates and coerces environment variables, reports every issue at once without printing values, returns a frozen, typo-proof object that hides secrets when logged. `envExample()` generates `.env.example`.
- **secrets**: scanner for database URLs with passwords, app passwords, AWS/GitHub/Stripe/OpenAI/Anthropic/Google/Slack/SendGrid keys, JWTs, private keys and hard-coded secrets; `.env` git-hygiene checks; pre-commit hook installer (husky-aware, never overwrites).
- **express**: `errorHandler()` with Mongoose, MongoDB, jsonwebtoken, body-parser and multer mapping; `validate()` with mass-assignment protection; `asyncHandler()`, `notFound()`, `HttpError`, `ok()`, `created()`. Works with Express 4 and 5.
- **edge**: `probe()` / `assertEdges()` try 20–40 edge cases per argument and report crashes, NaN, invalid dates, suspicious output, input mutation, prototype pollution, async hangs and invariant violations, with a suggested fix for each.
- **CLI**: `railguard check | scan | hook | init | example | probe`.
- TypeScript types with schema inference.
