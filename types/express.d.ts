import type { Field, Issue, Shape } from './schema.js'
export { t } from './schema.js'

export type Next = (err?: unknown) => void
export type Middleware<Req = any, Res = any> = (req: Req, res: Res, next: Next) => void
export type ErrorMiddleware<Req = any, Res = any> = (err: unknown, req: Req, res: Res, next: Next) => void

export interface HttpErrorOptions {
  code?: string
  details?: unknown
  /** Show the message to clients. Defaults to true for 4xx, false for 5xx. */
  expose?: boolean
  cause?: unknown
}

export declare class HttpError extends Error {
  status: number
  code: string
  details?: unknown
  expose: boolean
  constructor(status?: number, message?: string, options?: HttpErrorOptions)
  static badRequest(message?: string, details?: unknown): HttpError
  static unauthorized(message?: string): HttpError
  static forbidden(message?: string): HttpError
  static notFound(message?: string): HttpError
  static conflict(message?: string, details?: unknown): HttpError
  static unprocessable(message?: string, details?: unknown): HttpError
  static tooManyRequests(message?: string): HttpError
  static internal(message?: string): HttpError
}

/** Forward async errors to your error middleware (needed on Express 4; Express 5 does it natively). */
export declare function asyncHandler<Req = any, Res = any>(
  fn: (err: any, req: Req, res: Res, next: Next) => unknown
): ErrorMiddleware<Req, Res>
export declare function asyncHandler<Req = any, Res = any>(
  fn: (req: Req, res: Res, next: Next) => unknown
): Middleware<Req, Res>

export interface NormalizedError {
  status: number
  code: string
  message: string
  details?: unknown
  expose: boolean
}

/** Knows Mongoose, the MongoDB driver, jsonwebtoken, body-parser and multer errors. */
export declare function normalizeError(err: unknown): NormalizedError

export interface ErrorHandlerOptions {
  /** Called for 5xx errors. Defaults to console.error; false to disable. */
  log?: false | ((err: unknown, req: any) => void)
  /** Hide 5xx messages and stacks. Defaults to true unless NODE_ENV is "development" or "test". */
  production?: boolean
  /** Map your own error types to an HttpError. */
  map?: (err: unknown) => HttpError | undefined | void
}

/** `{ success: false, error: { code, message, details? } }` for every error. */
export declare function errorHandler(options?: ErrorHandlerOptions): ErrorMiddleware
export declare function notFound(): Middleware

export interface ValidateSchemas {
  params?: Shape | Field<any>
  query?: Shape | Field<any>
  body?: Shape | Field<any>
}

/** Validate params/query/body; 400 VALIDATION_ERROR with every issue on failure. */
export declare function validate(schemas: ValidateSchemas): Middleware

export interface SuccessBody<T> {
  success: true
  data: T
  meta?: unknown
}
export declare function ok<T>(res: any, data?: T, options?: { status?: number; meta?: unknown }): any
export declare function created<T>(res: any, data?: T): any

export type { Issue }
