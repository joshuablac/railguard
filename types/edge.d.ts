export interface EdgeCase {
  label: string
  make: () => unknown
}

export interface ArgSpec {
  type: string
  sample: () => unknown
  cases: EdgeCase[]
  wrong: EdgeCase[]
}

export type ArgType = 'string' | 'number' | 'int' | 'integer' | 'boolean' | 'array' | 'object' | 'date' | 'any'

export interface SpecOptions<T> {
  /** A valid input for your function, used for the other arguments while one is varied. */
  sample?: T | (() => T)
  /** Extra cases of your own. */
  extra?: unknown[]
}

export declare const edge: {
  string(opts?: SpecOptions<string>): ArgSpec
  number(opts?: SpecOptions<number>): ArgSpec
  boolean(opts?: SpecOptions<boolean>): ArgSpec
  array(opts?: SpecOptions<unknown[]>): ArgSpec
  object(opts?: SpecOptions<object>): ArgSpec
  date(opts?: SpecOptions<Date>): ArgSpec
  any(opts?: SpecOptions<unknown>): ArgSpec
  /** `edge.custom('valid@mail.com', ['a@', '@b.c'])` */
  custom(sample: unknown, cases?: unknown[]): ArgSpec
}

export interface ProbeOptions {
  args?: (ArgType | ArgSpec)[]
  /** Return true for errors your function throws on purpose. */
  allow?: (error: unknown, args: unknown[]) => boolean
  /** A rule every result must satisfy. */
  invariant?: (result: any, args: unknown[]) => boolean
  /** Treat every throw as a failure (default: only accidental crashes). */
  strict?: boolean
  /** Flag functions that modify their arguments (default true). */
  mutation?: boolean
  /** Also try null, undefined and wrong types (default true). */
  wrongTypes?: boolean
  /** ms before an async call counts as hung (default 2000). */
  timeout?: number
}

export type FailureKind = 'crash' | 'throws' | 'timeout' | 'nan' | 'invalid-date' | 'output' | 'mutation' | 'invariant' | 'pollution'

export interface CaseResult {
  /** 0-based argument index; null for the "no arguments" call. */
  arg: number | null
  label: string
  input?: string
  status: 'passed' | 'failed' | 'rejected'
  kind?: FailureKind | 'rejected' | 'allowed'
  message?: string
  hint?: string
}

export interface Problem {
  arg: number | null
  kind: FailureKind
  message: string
  hint?: string
  labels: string[]
}

export interface ProbeReport {
  name: string
  signature: string
  total: number
  passed: number
  failed: CaseResult[]
  rejected: CaseResult[]
  /** Failures grouped by cause. */
  problems: Problem[]
  results: CaseResult[]
  baselineError?: string
  ok: boolean
  toString(): string
}

export declare function probe(fn: (...args: any[]) => unknown, options?: ProbeOptions): Promise<ProbeReport>
/** probe() that throws an EdgeCaseError on failure. For node:test, Jest and Vitest. */
export declare function assertEdges(fn: (...args: any[]) => unknown, options?: ProbeOptions): Promise<ProbeReport>
export declare function formatReport(report: ProbeReport): string
export declare function groupFailures(failed: CaseResult[]): Problem[]
export declare function guessArgs(fn: (...args: any[]) => unknown): Promise<ArgSpec[] | null>

export declare class EdgeCaseError extends Error {
  report: ProbeReport
  constructor(report: ProbeReport)
}
