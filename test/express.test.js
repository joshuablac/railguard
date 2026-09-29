import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HttpError, asyncHandler, errorHandler, notFound, validate, ok, created, t } from '../src/express.js'

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      this.headersSent = true
      return this
    },
  }
}

function handle(err, options = { log: false, production: false }) {
  const res = mockRes()
  let forwarded
  errorHandler(options)(err, { method: 'GET', originalUrl: '/x' }, res, (e) => (forwarded = e))
  return { res, forwarded }
}

test('errorHandler has exactly four parameters (Express detects error middleware by arity)', () => {
  assert.equal(errorHandler().length, 4)
})

test('HttpError becomes the standard shape', () => {
  const { res } = handle(HttpError.notFound('Lesson not found'))
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.body, { success: false, error: { code: 'NOT_FOUND', message: 'Lesson not found' } })
  assert.equal(new HttpError(200).status, 500, 'non-error status codes are coerced to 500')
})

test('Mongoose ValidationError → 400 with field details', () => {
  const err = Object.assign(new Error('x'), {
    name: 'ValidationError',
    errors: { email: { path: 'email', message: 'Email is required' }, age: { path: 'age', message: 'Too young' } },
  })
  const { res } = handle(err)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'VALIDATION_ERROR')
  assert.deepEqual(res.body.error.details, [
    { path: 'email', message: 'Email is required' },
    { path: 'age', message: 'Too young' },
  ])
})

test('Mongoose CastError, duplicate key, JWT, body-parser, multer', () => {
  assert.equal(handle(Object.assign(new Error(), { name: 'CastError', kind: 'ObjectId', path: '_id' })).res.body.error.code, 'INVALID_ID')

  const dup = handle(Object.assign(new Error('E11000'), { code: 11000, keyValue: { email: 'private@person.com' } })).res
  assert.equal(dup.statusCode, 409)
  assert.equal(dup.body.error.message, 'email already exists')
  assert.ok(!JSON.stringify(dup.body).includes('private@person.com'), 'duplicate values are not echoed')

  assert.equal(handle(Object.assign(new Error(), { name: 'TokenExpiredError' })).res.body.error.code, 'TOKEN_EXPIRED')
  assert.equal(handle(Object.assign(new Error(), { name: 'JsonWebTokenError' })).res.statusCode, 401)
  assert.equal(handle(Object.assign(new Error(), { type: 'entity.parse.failed', status: 400 })).res.body.error.code, 'INVALID_JSON')
  assert.equal(handle(Object.assign(new Error(), { type: 'entity.too.large', status: 413 })).res.statusCode, 413)
  assert.equal(handle(Object.assign(new Error('File too large'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' })).res.statusCode, 413)
})

test('unknown errors: detail in development, generic in production', () => {
  const dev = handle(new Error('db exploded at 10.0.0.5')).res
  assert.equal(dev.statusCode, 500)
  assert.equal(dev.body.error.message, 'db exploded at 10.0.0.5')
  assert.ok(Array.isArray(dev.body.error.stack))

  const prod = handle(new Error('db exploded at 10.0.0.5'), { log: false, production: true }).res
  assert.deepEqual(prod.body, { success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } })
})

test('unset NODE_ENV counts as production: no stacks or 5xx messages leak', () => {
  const saved = process.env.NODE_ENV
  try {
    for (const value of [undefined, 'staging', 'production']) {
      if (value === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = value
      const { res } = handle(new Error('db password is hunter2'), { log: false })
      assert.equal(res.body.error.message, 'Something went wrong', `NODE_ENV=${value}`)
      assert.equal(res.body.error.stack, undefined)
    }
    process.env.NODE_ENV = 'development'
    assert.equal(handle(new Error('visible in dev'), { log: false }).res.body.error.message, 'visible in dev')
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = saved
  }
})

test('weird throws: strings, undefined, null', () => {
  for (const v of ['oops', undefined, null, 42]) {
    const { res } = handle(v, { log: false, production: true })
    assert.equal(res.statusCode, 500)
  }
})

test('logs 5xx only, and hands off if headers were already sent', () => {
  const logged = []
  const res = mockRes()
  errorHandler({ log: (e) => logged.push(e), production: true })(HttpError.badRequest('x'), {}, res, () => {})
  errorHandler({ log: (e) => logged.push(e), production: true })(new Error('boom'), {}, mockRes(), () => {})
  assert.equal(logged.length, 1)

  const sent = mockRes()
  sent.headersSent = true
  let forwarded
  const err = new Error('late')
  errorHandler({ log: false })(err, {}, sent, (e) => (forwarded = e))
  assert.equal(forwarded, err)
})

test('asyncHandler forwards rejections and sync throws', async () => {
  const boom = new Error('boom')
  const got = []
  asyncHandler(async () => {
    throw boom
  })({}, {}, (e) => got.push(e))
  asyncHandler(() => {
    throw boom
  })({}, {}, (e) => got.push(e))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(got, [boom, boom])
  assert.equal(asyncHandler(async (err, req, res, next) => {}).length, 4, 'error middleware keeps its arity')
  assert.throws(() => asyncHandler('nope'), TypeError)
})

test('validate: coerces query/params, strips unknown body keys, sets req.valid', () => {
  const mw = validate({
    params: { id: t.string({ min: 1 }) },
    query: { page: t.int({ min: 1 }).default(1), tags: t.array(t.string()).optional() },
    body: { name: t.string({ min: 1 }), email: t.email({ normalize: true }) },
  })
  const req = { params: { id: 'abc' }, query: { tags: 'a,b' }, body: { name: 'Jo', email: ' Jo@X.co ', role: 'admin' } }
  let called
  mw(req, {}, (e) => (called = e ?? 'ok'))
  assert.equal(called, 'ok')
  assert.deepEqual(req.body, { name: 'Jo', email: 'jo@x.co' })
  assert.deepEqual(req.query, { page: 1, tags: ['a', 'b'] })
  assert.deepEqual(req.valid.params, { id: 'abc' })
})

test('validate works when req.query is a getter (Express 5)', () => {
  class Req {
    get query() {
      return { page: '2' }
    }
  }
  const req = new Req()
  let err
  validate({ query: { page: t.int() } })(req, {}, (e) => (err = e))
  assert.equal(err, undefined)
  assert.deepEqual(req.query, { page: 2 })
})

test('validate: one 400 listing every problem', () => {
  let err
  validate({ body: { name: t.string(), email: t.email() } })({ body: { email: 'nope' } }, {}, (e) => (err = e))
  assert.ok(err instanceof HttpError)
  assert.equal(err.status, 400)
  assert.deepEqual(err.details.map((d) => d.path), ['body.name', 'body.email'])

  validate({ body: { name: t.string() } })({}, {}, (e) => (err = e))
  assert.deepEqual(err.details, [{ path: 'body.name', message: 'is required' }], 'a missing body names each missing field')
})

test('notFound, ok, created', () => {
  let err
  notFound()({ method: 'GET', originalUrl: '/nope?token=abc' }, {}, (e) => (err = e))
  assert.equal(err.status, 404)
  assert.equal(err.message, 'Route not found: GET /nope', 'query string (may hold tokens) is not echoed')

  const r1 = mockRes()
  ok(r1, { id: 1 }, { meta: { page: 1 } })
  assert.deepEqual(r1.body, { success: true, data: { id: 1 }, meta: { page: 1 } })
  const r2 = mockRes()
  created(r2, { id: 2 })
  assert.equal(r2.statusCode, 201)
})

test('works with a plain node:http response too', () => {
  const headers = {}
  let ended
  const res = { setHeader: (k, v) => (headers[k] = v), end: (b) => (ended = b) }
  ok(res, [1])
  assert.equal(res.statusCode, 200)
  assert.equal(ended, '{"success":true,"data":[1]}')
  assert.match(headers['content-type'], /application\/json/)
})
