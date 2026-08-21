const { test } = require('node:test')
const assert = require('node:assert/strict')

test('pre-existing failure', () => {
  assert.equal(1, 2)
})
