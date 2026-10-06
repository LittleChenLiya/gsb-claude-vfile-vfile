import assert from 'node:assert/strict'
import test from 'node:test'
import {EditChain, mapMessages} from '../lib/edit-chain.js'

test('insert at start of first line shifts an original range', function () {
  const chain = new EditChain('abc\ndef\n')
  // Diagnostic on `bc` (line 1, columns 2-3, offsets 1..3) at version 0.
  chain.push({offset: 0, endOffset: 0, text: 'XY'})

  assert.equal(chain.version, 1)
  assert.equal(chain.text, 'XYabc\ndef\n')

  const range = chain.mapRange(
    {start: {line: 1, column: 2}, end: {line: 1, column: 4}},
    0
  )
  assert.deepEqual(range, {
    start: {line: 1, column: 4},
    end: {line: 1, column: 6},
    deleted: false,
    version: 1
  })
  // The mapped range still selects `bc` in the new text.
  assert.equal(chain.text.slice(3, 5), 'bc')

  const offset = chain.mapOffset(1, 0)
  assert.deepEqual(offset, {offset: 3, deleted: false, version: 1})

  const point = chain.mapPoint({line: 2, column: 2}, 0)
  assert.deepEqual(point, {line: 2, column: 2, deleted: false, version: 1})
})

test('deleting text that contains an error marks it deleted', function () {
  const text = 'good\nbad error here\ntail\n'
  const chain = new EditChain(text)
  const start = text.indexOf('bad error here')
  chain.push({offset: start, endOffset: start + 'bad error here'.length, text: ''})

  // Point strictly inside the deleted text (`error`, line 2, column 9).
  const point = chain.mapPoint({line: 2, column: 9}, 0)
  assert.equal(point.deleted, true)
  assert.equal(point.version, 1)

  // Range fully inside the deleted text.
  const range = chain.mapRange(
    {start: {line: 2, column: 5}, end: {line: 2, column: 10}},
    0
  )
  assert.equal(range.deleted, true)

  // Range spanning across the deleted text is also deleted.
  const spanning = chain.mapRange(
    {start: {line: 1, column: 2}, end: {line: 3, column: 2}},
    0
  )
  assert.equal(spanning.deleted, true)

  // Text after the deletion survives and shifts
  // (the line ending stays, so line 2 becomes empty).
  const tail = chain.mapPoint({line: 3, column: 1}, 0)
  assert.deepEqual(tail, {line: 3, column: 1, deleted: false, version: 1})
  assert.equal(chain.text, 'good\n\ntail\n')
})

test('emoji columns count UTF-16 code units, not bytes', function () {
  // `a`, then one emoji (2 UTF-16 units, 4 UTF-8 bytes), then `b`.
  const text = 'a\u{1F4A9}b\n'
  const chain = new EditChain(text)

  // `b` is at column 4 (1 + 2 + 1), not column 6 (bytes).
  const point = chain.mapPoint({line: 1, column: 4}, 0)
  assert.deepEqual(point, {line: 1, column: 4, deleted: false, version: 0})

  // Insert one ASCII char before the emoji: `b` moves to column 5.
  chain.push({offset: 1, endOffset: 1, text: 'Z'})
  const shifted = chain.mapPoint({line: 1, column: 4}, 0)
  assert.deepEqual(shifted, {line: 1, column: 5, deleted: false, version: 1})
  assert.equal(chain.text, 'aZ\u{1F4A9}b\n')

  // Byte offsets are a separate API: `b` starts at byte 5 (1 + 4).
  const bytes = chain.mapByteOffset(5, 0)
  assert.deepEqual(bytes, {offset: 6, deleted: false, version: 1})

  // A byte offset inside the emoji is rejected.
  assert.throws(function () {
    chain.mapByteOffset(3, 0)
  }, /not on a UTF-8 character boundary/)
})

test('CRLF and multi-line ranges are preserved', function () {
  const text = 'one\r\ntwo\r\nthree\r\n'
  const chain = new EditChain(text)
  // Insert at the start of line 2 (offset 5, right after the first CRLF).
  chain.push({offset: 5, endOffset: 5, text: '>> '})

  assert.equal(chain.text, 'one\r\n>> two\r\nthree\r\n')

  // Multi-line range from line 1 into line 3 keeps CRLF structure.
  const range = chain.mapRange(
    {start: {line: 1, column: 2}, end: {line: 3, column: 3}},
    0
  )
  assert.deepEqual(range, {
    start: {line: 1, column: 2},
    end: {line: 3, column: 3},
    deleted: false,
    version: 1
  })

  // A point on line 2 shifts by the inserted 3 columns, still on line 2.
  const point = chain.mapPoint({line: 2, column: 2}, 0)
  assert.deepEqual(point, {line: 2, column: 5, deleted: false, version: 1})

  // A point on line 3 stays on line 3 (CRLF counts as one line ending).
  const later = chain.mapPoint({line: 3, column: 4}, 0)
  assert.deepEqual(later, {line: 3, column: 4, deleted: false, version: 1})
})

test('overlapping edits are rejected before applying', function () {
  const chain = new EditChain('abcdef')
  chain.push({offset: 1, endOffset: 3, text: 'XX'})

  // Overlaps the replaced region [1, 3).
  assert.throws(function () {
    chain.push({offset: 2, endOffset: 4, text: 'y'})
  }, /Overlapping edit/)

  // Insertion strictly inside the replaced region is also rejected.
  assert.throws(function () {
    chain.push({offset: 2, endOffset: 2, text: 'y'})
  }, /Overlapping edit/)

  // Failed pushes did not change the chain.
  assert.equal(chain.version, 1)
  assert.equal(chain.text, 'aXXdef')

  // Deletion overlapping a previous deletion site is rejected too.
  chain.push({offset: 4, endOffset: 5, text: ''})
  assert.throws(function () {
    chain.push({offset: 3, endOffset: 5, text: ''})
  }, /Overlapping edit/)

  // Adjacent, non-overlapping edits are fine.
  chain.push({offset: 3, endOffset: 3, text: '!'})
  assert.equal(chain.text, 'aXX!df')
})

test('edits are located by post-execution state and versions bind', function () {
  const chain = new EditChain('abcdef')
  chain.push({offset: 0, endOffset: 0, text: '## '})
  // The second edit addresses the text *after* the first edit:
  // offset 6 is `d` in `## abcdef`, not in the original text.
  chain.push({offset: 6, endOffset: 7, text: ''})
  assert.equal(chain.text, '## abcef')
  assert.equal(chain.version, 2)

  // A position known at version 1 maps through only the later edits.
  const fromV1 = chain.mapOffset(4, 1)
  assert.deepEqual(fromV1, {offset: 4, deleted: false, version: 2})

  // The same character known at version 0 maps through the whole chain.
  const fromV0 = chain.mapOffset(1, 0)
  assert.deepEqual(fromV0, {offset: 4, deleted: false, version: 2})

  // The deleted character is marked deleted from either version.
  assert.equal(chain.mapOffset(3, 0).deleted, true) // `d` in v0 coords
  assert.equal(chain.mapOffset(6, 1).deleted, true) // `d` in v1 coords
  assert.equal(chain.mapOffset(5, 1).deleted, false) // `c` in v1 coords

  // Results carry the version they are bound to.
  assert.equal(chain.mapPoint({line: 1, column: 2}, 0).version, 2)

  // Unknown versions are rejected.
  assert.throws(function () {
    chain.mapOffset(0, 3)
  }, /Unknown version 3/)
  assert.throws(function () {
    chain.mapOffset(0, -1)
  }, /Unknown version -1/)

  // Snapshots per version stay available.
  assert.equal(chain.textAt(0), 'abcdef')
  assert.equal(chain.textAt(1), '## abcdef')
  assert.equal(chain.textAt(2), '## abcef')
})

test('mapMessages creates a new view and never mutates the old file', function () {
  const text = 'alpha\nbeta bad gamma\ndelta\n'
  const chain = new EditChain(text)
  chain.push({offset: 0, endOffset: 0, text: '>> '})
  const start = chain.text.indexOf('bad')
  chain.push({offset: start, endOffset: start + 3, text: ''})

  const warning = {
    reason: 'first line note',
    line: 1,
    column: 2,
    offset: 1,
    fatal: false
  }
  const error = {
    reason: 'bad word',
    line: 2,
    column: 7,
    offset: text.indexOf('bad'),
    fatal: true,
    place: {
      start: {line: 2, column: 6},
      end: {line: 2, column: 9}
    }
  }
  const file = {messages: [warning, error]}

  const view = mapMessages(file, chain, 0)

  assert.equal(view.length, 2)
  assert.equal(view[0].version, 2)
  assert.equal(view[1].version, 2)

  // Shifted by the 3 inserted columns on line 1.
  assert.equal(view[0].line, 1)
  assert.equal(view[0].column, 5)
  assert.equal(view[0].offset, 4)
  assert.equal(view[0].deleted, undefined)

  // Inside the deleted word: marked deleted, position clamped.
  assert.equal(view[1].deleted, true)

  // The old file and its messages are untouched.
  assert.equal(file.messages[0], warning)
  assert.equal(warning.column, 2)
  assert.equal(warning.offset, 1)
  assert.equal(error.column, 7)
  assert.equal(error.deleted, undefined)
  assert.deepEqual(error.place, {
    start: {line: 2, column: 6},
    end: {line: 2, column: 9}
  })

  // The view is a fresh array of fresh objects.
  assert.notEqual(view, file.messages)
  assert.notEqual(view[0], warning)
  assert.notEqual(view[1].place, error.place)

  // `place` ranges are mapped too: the deleted word collapses to the
  // deletion site (line 2, column 6 in the new text).
  assert.deepEqual(view[1].place, {
    start: {line: 2, column: 6},
    end: {line: 2, column: 6}
  })
  assert.equal(view[1].offset, text.indexOf('bad') + 3)
})

test('mapMessages accepts a bare array and point places', function () {
  const chain = new EditChain('xyz')
  chain.push({offset: 3, endOffset: 3, text: '!'})

  const view = mapMessages(
    [{reason: 'note', place: {line: 1, column: 3}}],
    chain,
    0
  )
  assert.deepEqual(view[0].place, {line: 1, column: 3})
  assert.equal(view[0].line, 1)
  assert.equal(view[0].column, 3)
  assert.equal(view[0].version, 1)
})
