import type { Field, Infer, Issue, Shape } from './schema.js'
import { ValidationError } from './schema.js'
export { t } from './schema.js'

export declare class EnvError extends ValidationError {}

export interface GuardOptions {
  /** Defaults to process.env (with .env loaded underneath it). */
  source?: Record<string, string | undefined>
  /** dotenv file to load. Defaults to ".env" when reading process.env; false to disable. */
  file?: string | false
}

/**
 * Validate environment variables at startup. Reports every problem at once, coerces
 * values ("3000" → 3000), and returns a frozen object that throws on unknown keys.
 */
export declare function guard<S extends Shape>(schema: S, options?: GuardOptions): Readonly<Infer<S>>
export declare function guard<S extends Shape, R>(
  schema: S,
  options: GuardOptions & { onError: (error: EnvError) => R }
): Readonly<Infer<S>> | R

/** Text of a .env.example generated from the schema. Secret defaults are never written. */
export declare function envExample(schema: Shape): string
export declare function formatEnvIssues(issues: Issue[], schema?: Shape): string
export declare function readEnvFile(file: string): Record<string, string>
export declare function isSecretKey(key: string, field?: Field<any>, value?: unknown): boolean
