// Example schema for a MERN server. Generate your own with: npx railguard init
const { t } = require('railguard')

module.exports = {
  NODE_ENV: t.enum(['development', 'production', 'test']).default('development'),
  PORT: t.port().default(5000),
  MONGO_DB: t.url().describe('MongoDB connection string'),
  JWT_SECRET: t.string({ min: 32 }).secret().describe('Generate with: node -e "console.log(crypto.randomBytes(48).toString(\'hex\'))"'),
  SENDER_EMAIL: t.email(),
  EMAIL_PASS: t.string({ min: 1 }).secret().describe('Gmail app password'),
  CLIENT_URL: t.url().describe('Frontend origin for CORS'),
}
