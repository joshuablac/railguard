export interface Issue {
  /** e.g. "PORT", "body.email", "body.tags[1]" */
  path: string
  /** Never contains the received value. */
  message: string
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] }

export declare class Field<T = unknown> {
  readonly kind: string
  /** Human description of what is expected, e.g. "a port number (1-65535)". */
  readonly rule: string
  readonly isOptional: boolean
  readonly hasDefault: boolean
  readonly isSecret: boolean
  readonly description?: string
  /** Value may be missing; it resolves to `undefined`. */
  optional(): Field<T | undefined>
  /** Value used when missing. Pass a function to build a fresh value each time. */
  default(value: NonNullable<T> | (() => NonNullable<T>)): Field<NonNullable<T>>
  /** Hide this value when the env object is logged. */
  secret(): Field<T>
  /** Shown in error messages and generated .env.example files. */
  describe(text: string): Field<T>
  parse(input: unknown, options?: { coerce?: boolean; path?: string }): ParseResult<T>
}

export type Shape = Record<string, Field<any>>

/** The parsed type of a field or a `{ key: field }` shape. */
export type Infer<S> = S extends Field<infer T>
  ? T
  : S extends Shape
    ? { [K in keyof S]: S[K] extends Field<infer T> ? T : never }
    : never

export declare const t: {
  string(opts?: { min?: number; max?: number; pattern?: RegExp; trim?: boolean }): Field<string>
  number(opts?: { min?: number; max?: number; int?: boolean }): Field<number>
  int(opts?: { min?: number; max?: number }): Field<number>
  port(): Field<number>
  boolean(): Field<boolean>
  enum<const V extends readonly [string, ...string[]]>(values: V): Field<V[number]>
  url(opts?: { protocols?: string[] }): Field<string>
  /** normalize: trim + lowercase */
  email(opts?: { normalize?: boolean }): Field<string>
  json<T = unknown>(): Field<T>
  array<T>(item: Field<T>, opts?: { min?: number; max?: number }): Field<T[]>
  /** Unknown keys are dropped by default ("strip"), which blocks mass-assignment. */
  object<S extends Shape>(shape: S, opts?: { unknown?: 'strip' | 'reject' | 'keep' }): Field<Infer<S>>
  any(): Field<unknown>
}

export declare class ValidationError extends Error {
  issues: Issue[]
  constructor(message: string, issues?: Issue[])
}

/** Validate `input` against a field or a `{ key: field }` shape. */
export declare function check<S extends Shape | Field<any>>(
  schema: S,
  input: unknown,
  options?: { coerce?: boolean }
): ParseResult<Infer<S>>
