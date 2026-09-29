// Run: node --test examples/utils.test.js
import { test } from 'node:test'
import { assertEdges } from 'railguard/edge'
import { getInitialsSafe, getInitials } from './utils.js'

test('getInitialsSafe handles every edge case', () => assertEdges(getInitialsSafe, { args: ['string'] }))

test('getInitials (the naive version) is caught', { todo: 'fix getInitials, then delete this todo' }, () =>
  assertEdges(getInitials, { args: ['string'] }))
