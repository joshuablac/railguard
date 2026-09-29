// Express toolkit. No dependency on express: everything is plain (req, res, next).
// Works with Express 4 and 5 (and anything else with the same middleware signature).
import { runField, t, toField, _FAIL } from './schema.js'

export { t }

const STATUS_TEXT = {
  400: 'Bad request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not found', 405: 'Method not allowed',
  408: 'Request timeout', 409: 'Conflict', 410: 'Gone', 413: 'Payload too large', 415: 'Unsupported media type',
  422: 'Unprocessable entity', 429: 'Too many requests', 500: 'Something went wrong', 501: 'Not implemented',
  502: 'Bad gateway', 503: 'Service unavailable', 504: 'Gateway timeout',
}

const STATUS_CODE = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED',
  408: 'REQUEST_TIMEOUT', 409: 'CONFLICT', 410: 'GONE', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY', 429: 'TOO_MANY_REQUESTS', 500: 'INTERNAL_ERROR', 501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY', 503: 'SERVICE_UNAVAILABLE', 504: 'GATEWAY_TIMEOUT',
}

function validStatus(status) {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
}

export class HttpError extends Error {
  /**
   * @param {number} status 4xx or 5xx
   * @param {string} [message]
   * @param {{ code?: string, details?: unknown, expose?: boolean, cause?: unknown }} [options]
   */
  constructor(status = 500, message, options = {}) {
    const s = validStatus(status)
    super(message ?? STATUS_TEXT[s] ?? 'Error', options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HttpError'
    this.status = s
    this.code = options.code ?? STATUS_CODE[s] ?? (s < 500 ? 'CLIENT_ERROR' : 'SERVER_ERROR')
    this.details = options.details
    this.expose = options.expose ?? s < 500
  }

  static badRequest(message, details) { return new HttpError(400, message, { details }) }
  static unauthorized(message = 'Please log in to continue') { return new HttpError(401, message) }
  static forbidden(message = 'You do not have permission to do that') { return new HttpError(403, message) }
  static notFound(message = 'Not found') { return new HttpError(404, message) }
  static conflict(message, details) { return new HttpError(409, message, { details }) }
  static unprocessable(message, details) { return new HttpError(422, message, { details }) }
  static tooManyRequests(message = 'Too many requests, slow down') { return new HttpError(429, message) }
  static internal(message) { return new HttpError(500, message) }
}

/**
 * Forward errors from async route handlers to your error middleware.
 * Express 5 already does this; on Express 4 it saves you a try/catch in every route.
 * Keeps 4-argument error middleware working (Express detects them by arity).
 */
export function asyncHandler(fn) {
  if (typeof fn !== 'function') throw new TypeError('railguard: asyncHandler() needs a function')
  if (fn.length === 4) {
    return function railguardAsyncErrorHandler(err, req, res, next) {
      try {
        const r = fn(err, req, res, next)
        if (r && typeof r.then === 'function') r.then(undefined, next)
      } catch (e) {
        next(e)
      }
    }
  }
  return function railguardAsyncHandler(req, res, next) {
    try {
      const r = fn(req, res, next)
      if (r && typeof r.then === 'function') r.then(undefined, next)
    } catch (e) {
      next(e)
    }
  }
}

function send(res, status, body) {
  if (typeof res.status === 'function' && typeof res.json === 'function') return res.status(status).json(body)
  res.statusCode = status
  res.setHeader?.('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
  return res
}

/** 200 `{ success: true, data }` (add `meta` for pagination etc.). */
export function ok(res, data = null, { status = 200, meta } = {}) {
  return send(res, status, meta === undefined ? { success: true, data } : { success: true, data, meta })
}

/** 201 `{ success: true, data }`. */
export function created(res, data = null) {
  return ok(res, data, { status: 201 })
}

/**
 * Turn any thrown value into `{ status, code, message, details, expose }`.
 * Knows Mongoose, the MongoDB driver, jsonwebtoken, body-parser and multer by
 * error name/code, without depending on any of them.
 */
export function normalizeError(err) {
  if (err === null || typeof err !== 'object') {
    return { status: 500, code: 'INTERNAL_ERROR', message: String(err), expose: false }
  }
  const name = err.name
  if (err instanceof HttpError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details, expose: err.expose }
  }
  if (name === 'ValidationError' && err.errors && typeof err.errors === 'object') {
    const details = Object.values(err.errors).map((e) => ({ path: e?.path, message: e?.message }))
    return { status: 400, code: 'VALIDATION_ERROR', message: 'Validation failed', details, expose: true }
  }
  if (name === 'CastError') {
    const isId = err.kind === 'ObjectId'
    return { status: 400, code: isId ? 'INVALID_ID' : 'INVALID_VALUE', message: `Invalid ${err.path ?? 'value'}`, expose: true }
  }
  if (err.code === 11000 || err.code === 11001) {
    const fields = Object.keys(err.keyValue ?? err.keyPattern ?? {})
    const what = fields.length ? fields.join(', ') : 'A record with this value'
    return { status: 409, code: 'DUPLICATE', message: `${what} already exists`, details: { fields }, expose: true }
  }
  if (name === 'TokenExpiredError') {
    return { status: 401, code: 'TOKEN_EXPIRED', message: 'Your session has expired. Please log in again.', expose: true }
  }
  if (name === 'JsonWebTokenError') return { status: 401, code: 'INVALID_TOKEN', message: 'Invalid token', expose: true }
  if (name === 'NotBeforeError') return { status: 401, code: 'TOKEN_NOT_ACTIVE', message: 'Token is not active yet', expose: true }
  if (err.type === 'entity.parse.failed') {
    return { status: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON', expose: true }
  }
  if (err.type === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large', expose: true }
  }
  if (name === 'MulterError') {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
    return { status, code: err.code ?? 'UPLOAD_ERROR', message: err.message || 'Upload failed', expose: true }
  }
  const status = validStatus(err.status ?? err.statusCode)
  if (status < 500 || err.expose === true) {
    return {
      status,
      code: typeof err.code === 'string' ? err.code : STATUS_CODE[status] ?? 'CLIENT_ERROR',
      message: err.message || STATUS_TEXT[status] || 'Error',
      details: err.details,
      expose: err.expose ?? true,
    }
  }
  return { status, code: STATUS_CODE[status] ?? 'INTERNAL_ERROR', message: err.message || 'Error', expose: false }
}

function defaultLog(err, req) {
  console.error(`[railguard] ${req?.method ?? ''} ${req?.originalUrl ?? req?.url ?? ''} failed:`, err)
}

/**
 * Central error middleware: one JSON shape for every error.
 * `{ success: false, error: { code, message, details? } }`
 * 5xx messages and stacks are sent only when NODE_ENV is "development" or "test";
 * everywhere else (including an unset NODE_ENV) clients get a generic message.
 *
 * @param {{ log?: false | ((err: unknown, req: any) => void), production?: boolean, map?: (err: unknown) => HttpError | undefined }} [options]
 */
export function errorHandler(options = {}) {
  const log = options.log === false ? null : options.log ?? defaultLog
  // Exactly four parameters: Express recognises error middleware by fn.length.
  return function railguardErrorHandler(err, req, res, next) {
    if (res.headersSent) return next(err)
    // Details go to the client only when NODE_ENV is explicitly development or test.
    // Many hosts leave NODE_ENV unset, and that must not leak stacks to users.
    const production = options.production ?? !['development', 'test'].includes(process.env.NODE_ENV)
    const mapped = options.map?.(err)
    const info = normalizeError(mapped ?? err)
    if (info.status >= 500 && log) log(err, req)
    const error = { code: info.code, message: info.message }
    if (!info.expose && production) error.message = STATUS_TEXT[info.status] ?? 'Something went wrong'
    if (info.details !== undefined) error.details = info.details
    if (!production && err && typeof err === 'object' && typeof err.stack === 'string' && info.status >= 500) {
      error.stack = err.stack.split('\n').map((l) => l.trim())
    }
    return send(res, info.status, { success: false, error })
  }
}

/** Catch-all 404 for unknown routes. Mount after your routes, before errorHandler(). */
export function notFound() {
  return function railguardNotFound(req, res, next) {
    next(new HttpError(404, `Route not found: ${req.method} ${(req.originalUrl ?? req.url ?? '').split('?')[0]}`, { code: 'ROUTE_NOT_FOUND' }))
  }
}

/**
 * Validate `req.params`, `req.query` and `req.body`. On success the parsed values
 * replace the originals (unknown body keys are dropped) and are also on `req.valid`.
 * On failure it calls `next()` with a 400 VALIDATION_ERROR listing every problem.
 * Query and params are coerced from strings ("5" → 5); the body is not.
 *
 * @param {{ params?: object, query?: object, body?: object }} schemas
 */
export function validate(schemas) {
  if (!schemas || typeof schemas !== 'object') throw new TypeError('railguard: validate() needs { body?, query?, params? }')
  const parts = ['params', 'query', 'body'].filter((p) => schemas[p]).map((p) => [p, toField(schemas[p])])
  if (!parts.length) throw new TypeError('railguard: validate() needs at least one of body, query or params')
  return function railguardValidate(req, res, next) {
    const issues = []
    const valid = {}
    for (const [part, field] of parts) {
      // A missing body (no JSON sent) is treated as {} so each missing field is named.
      const input = req[part] ?? {}
      const value = runField(field, input, { coerce: part !== 'body' }, part, issues)
      if (value !== _FAIL) valid[part] = value
    }
    if (issues.length) {
      return next(new HttpError(400, 'Validation failed', { code: 'VALIDATION_ERROR', details: issues }))
    }
    // req.query is a getter in Express 5, so shadow it with an own property instead of assigning.
    for (const [part] of parts) {
      Object.defineProperty(req, part, { value: valid[part], writable: true, configurable: true, enumerable: true })
    }
    req.valid = valid
    next()
  }
}
