// Typical helper functions, the kind an AI assistant writes in seconds.
// Try: npx railguard probe examples/utils.js

export function getInitials(fullName) {
  return fullName
    .split(' ')
    .map((part) => part[0].toUpperCase())
    .join('')
}

export function average(scores) {
  return scores.reduce((sum, s) => sum + s, 0) / scores.length
}

export function formatDate(date) {
  return date.toISOString().slice(0, 10)
}

export function greet(user) {
  return `Welcome back, ${user.firstName}!`
}

// The defensive version of getInitials: passes every case.
export function getInitialsSafe(fullName) {
  if (typeof fullName !== 'string') return ''
  return fullName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => [...part][0].toUpperCase())
    .join('')
}
