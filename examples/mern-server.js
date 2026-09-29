// A CommonJS Express server wired up with railguard.
// Needs: npm i express mongoose railguard
const express = require('express')
const mongoose = require('mongoose')
const { guard, t, validate, asyncHandler, errorHandler, notFound, ok, created, HttpError } = require('railguard')

const env = guard(require('./env.schema')) // stops here with a clear list if .env is wrong

const Lesson = mongoose.model('Lesson', new mongoose.Schema({
  title: { type: String, required: true },
  subject: { type: String, required: true },
  durationMinutes: { type: Number, min: 5 },
}))

const app = express()
app.use(express.json({ limit: '100kb' }))

const lessonBody = {
  title: t.string({ min: 1, max: 120, trim: true }),
  subject: t.enum(['math', 'english', 'science']),
  durationMinutes: t.int({ min: 5, max: 240 }).optional(),
}

app.get('/api/lessons', validate({ query: { page: t.int({ min: 1 }).default(1), limit: t.int({ min: 1, max: 50 }).default(10) } }),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query
    const lessons = await Lesson.find().skip((page - 1) * limit).limit(limit)
    ok(res, lessons, { meta: { page, limit } })
  }))

app.get('/api/lessons/:id', asyncHandler(async (req, res) => {
  const lesson = await Lesson.findById(req.params.id) // bad ids → 400 INVALID_ID automatically
  if (!lesson) throw HttpError.notFound('Lesson not found')
  ok(res, lesson)
}))

app.post('/api/lessons', validate({ body: lessonBody }), asyncHandler(async (req, res) => {
  created(res, await Lesson.create(req.body)) // unknown keys were already stripped
}))

app.use(notFound())
app.use(errorHandler())

mongoose.connect(env.MONGO_DB).then(() => {
  app.listen(env.PORT, () => console.log(`API on :${env.PORT} (${env.NODE_ENV})`))
})
