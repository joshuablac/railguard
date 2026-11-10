# Changelog

## 0.2.1 (2026-11-10)

- **secrets**: when `.env` is tracked by git *and* not in `.gitignore`, `check`/`scan` now say to do both: `git rm --cached .env`, then add it to `.gitignore`. Before, it only said to untrack it, so the next `git add .` committed it again.
- New agent skill in `skills/railguard/SKILL.md` for Claude Code, Cursor, Codex and other agents that read SKILL.md.

## 0.2.0 (2026-09-29)

- **ai**: new `npx railguard ai` command. It writes honest-reviewer rules into the files AI coding assistants read (AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules, .windsurfrules, .github/copilot-instructions.md). The assistant then warns when a secret is pasted into chat or about to be committed, checks edge cases before calling code done, follows safe API rules, and walks you through a pre-ship checklist. Re-running updates the block in place and never touches the rest of the file.
- The same rules are published in `llms.txt` and exported as `AI_RULES` / `installAiRules()`.

## 0.1.0 (2026-09-29)

First release.

- **env**: `guard()` validates and coerces environment variables, reports every issue at once without printing values, returns a frozen, typo-proof object that hides secrets when logged. `envExample()` generates `.env.example`.
- **secrets**: scanner for database URLs with passwords, app passwords, AWS/GitHub/Stripe/OpenAI/Anthropic/Google/Slack/SendGrid keys, JWTs, private keys and hard-coded secrets; `.env` git-hygiene checks; pre-commit hook installer (husky-aware, never overwrites).
- **express**: `errorHandler()` with Mongoose, MongoDB, jsonwebtoken, body-parser and multer mapping; `validate()` with mass-assignment protection; `asyncHandler()`, `notFound()`, `HttpError`, `ok()`, `created()`. Works with Express 4 and 5.
- **edge**: `probe()` / `assertEdges()` try 20–40 edge cases per argument and report crashes, NaN, invalid dates, suspicious output, input mutation, prototype pollution, async hangs and invariant violations, with a suggested fix for each.
- **CLI**: `railguard check | scan | hook | init | example | probe`.
- TypeScript types with schema inference.
