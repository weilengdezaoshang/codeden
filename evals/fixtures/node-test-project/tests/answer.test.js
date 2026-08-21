const { test } = require('node:test')
const assert = require('node:assert/strict')
const { answer } = require('../src/answer.js')

test('answer is 2', () => {
  assert.equal(answer, 2)
})
