const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ok } = require('../src/ok.js')

test('ok is 1', () => {
  assert.equal(ok, 1)
})
