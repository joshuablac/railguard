/** Instruction files read by popular AI coding assistants. */
export declare const AI_FILES: string[]
/** The honest-reviewer rules for AI assistants (markdown). */
export declare const AI_RULES_BODY: string
/** AI_RULES_BODY wrapped in railguard start/end markers. */
export declare const AI_RULES: string
/**
 * Write the rules into AI instruction files (AGENTS.md, CLAUDE.md, .cursorrules, ...).
 * Other content is kept; an earlier railguard block is replaced. Creates AGENTS.md if none exist.
 */
export declare function installAiRules(
  cwd?: string,
  options?: { files?: string[] }
): { file: string; status: 'created' | 'added' | 'updated' | 'unchanged' }[]
