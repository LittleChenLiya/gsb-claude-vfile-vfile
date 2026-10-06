/**
 * Tests for `lib/change-map.js`: explicit text-change position mapping.
 *
 * Run with:
 *
 *     node --test test-change-map.js
 *
 * A runnable three-edit example lives in `example-change-map.js`:
 *
 *     node example-change-map.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {ChangeChain, createChangeChain} from './lib/change-map.js'

const emoji = '\u{1F600}'

test('insertion before the first line shifts the original range', () => {
  const chain = createChangeChain('alpha\nbeta\n')
  chain.apply({start: 0, end: 0, replacement: '>> '})
  assert.equal(chain.value, '>> alpha\nbeta\n')

  // Diagnostic on `alpha` (offsets 0…5 in the original text).
  const alpha = chain.mapRange({
    start: {line: 1, column: 1, offset: 0},
    end: {line: 1, column: 6, offset: 5}
  })
  assert.ok(alpha)
  assert.deepEqual(alpha.start, {line: 1, column: 4, offset: 3, byteOffset: 3})
  assert.deepEqual(alpha.end, {line: 1, column: 9, offset: 8, byteOffset: 8})

  // Diagnostic on `beta` (second line) shifts by the same amount.
  const beta = chain.mapRange({
    start: {line: 2, column: 1, offset: 6},
    end: {line: 2, column: 5, offset: 10}
  })
  assert.ok(beta)
  assert.deepEqual(beta.start, {line: 2, column: 1, offset: 9, byteOffset: 9})
  assert.deepEqual(beta.end, {line: 2, column: 5, offset: 13, byteOffset: 13})
})

test('deleting the text that contains the error marks it deleted', () => {
  const chain = createChangeChain('alpha\nbeta\n')
  chain.apply({start: 6, end: 10, replacement: ''})
  assert.equal(chain.value, 'alpha\n\n')

  // Range fully inside the deleted text.
  assert.equal(
    chain.mapRange({
      start: {line: 2, column: 1, offset: 6},
      end: {line: 2, column: 5, offset: 10}
    }),
    null
  )
  // Range partially overlapping the deleted text.
  assert.equal(
    chain.mapRange({
      start: {line: 1, column: 5, offset: 4},
      end: {line: 2, column: 3, offset: 8}
    }),
    null
  )
  // Point strictly inside the deleted text.
  assert.equal(chain.mapPoint({line: 2, column: 2, offset: 7}), null)
  // Range before the deleted text is untouched.
  const alpha = chain.mapRange({
    start: {line: 1, column: 1, offset: 0},
    end: {line: 1, column: 6, offset: 5}
  })
  assert.ok(alpha)
  assert.equal(alpha.start.offset, 0)
  assert.equal(alpha.end.offset, 5)
})

test('emoji columns count UTF-16 code units, not bytes', () => {
  // `a` + emoji (2 UTF-16 units, 4 UTF-8 bytes) + `b`.
  const chain = createChangeChain('a' + emoji + 'b\n')
  chain.apply({start: 1, end: 1, replacement: 'xy'})
  assert.equal(chain.value, 'axy' + emoji + 'b\n')

  // Point at `b`, given as an explicit UTF-16 offset.
  const fromOffset = chain.mapPoint({offset: 3})
  assert.ok(fromOffset)
  // Column 6: `a`(1) `x`(2) `y`(3) emoji(4–5) `b`(6) — UTF-16, not bytes.
  assert.equal(fromOffset.column, 6)
  assert.equal(fromOffset.offset, 5)
  // Byte offset 7: `a`(1) + `x`(1) + `y`(1) + emoji(4).
  assert.equal(fromOffset.byteOffset, 7)
  assert.notEqual(fromOffset.column, fromOffset.byteOffset)

  // Same point given as `line`/`column` (column 4 in the original line:
  // `a`(1) emoji(2–3) `b`(4)) — again UTF-16 units, not bytes.
  const fromLineColumn = chain.mapPoint({line: 1, column: 4})
  assert.deepEqual(fromLineColumn, fromOffset)
})

test('CRLF line endings and multi-line ranges are preserved', () => {
  const chain = createChangeChain('one\r\ntwo\r\nthree')
  chain.apply({start: 0, end: 3, replacement: '1'})
  assert.equal(chain.value, '1\r\ntwo\r\nthree')

  // Range spanning from `two` through `three` (offsets 5…15).
  const range = chain.mapRange({
    start: {line: 2, column: 1},
    end: {line: 3, column: 6}
  })
  assert.ok(range)
  assert.deepEqual(range.start, {line: 2, column: 1, offset: 3, byteOffset: 3})
  assert.deepEqual(range.end, {line: 3, column: 6, offset: 13, byteOffset: 13})
  // The mapped range still covers exactly `two\r\nthree`.
  assert.equal(
    chain.value.slice(range.start.offset, range.end.offset),
    'two\r\nthree'
  )
})

test('overlapping edits are rejected up front', () => {
  const chain = createChangeChain('abcdefghij')
  chain.apply({start: 2, end: 8, replacement: 'LONG'})

  // Range intersecting the previously edited region [2, 6).
  assert.throws(() => chain.apply({start: 4, end: 5, replacement: 'x'}), RangeError)
  // Insertion strictly inside the previously edited region.
  assert.throws(() => chain.apply({start: 4, end: 4, replacement: 'x'}), RangeError)
  // Exactly the previously edited region.
  assert.throws(() => chain.apply({start: 2, end: 6, replacement: 'x'}), RangeError)
  // Abutting edits are fine.
  chain.apply({start: 6, end: 8, replacement: '!'})
  chain.apply({start: 0, end: 2, replacement: '?'})
  assert.equal(chain.value, '?LONG!')
  // Out-of-bounds and malformed edits are rejected too.
  assert.throws(() => chain.apply({start: -1, end: 1, replacement: ''}), RangeError)
  assert.throws(() => chain.apply({start: 3, end: 2, replacement: ''}), RangeError)
  assert.throws(() => chain.apply({start: 0, end: 99, replacement: ''}), RangeError)
})

test('three edits, each located against the post-edit state', () => {
  const base = 'one\ntwo ' + emoji + '\nthree\n'
  const chain = createChangeChain(base)

  // Edit 1: insert `>> ` before the first line.
  assert.equal(chain.apply({start: 0, end: 0, replacement: '>> '}), 1)
  assert.equal(chain.value, '>> one\ntwo ' + emoji + '\nthree\n')
  // Edit 2: replace `two`, now at offsets 7…10 in the *new* state.
  assert.equal(chain.apply({start: 7, end: 10, replacement: '2'}), 2)
  assert.equal(chain.value, '>> one\n2 ' + emoji + '\nthree\n')
  // Edit 3: delete `three`, now at offsets 12…17 in the *new* state.
  assert.equal(chain.apply({start: 12, end: 17, replacement: ''}), 3)
  assert.equal(chain.value, '>> one\n2 ' + emoji + '\n\n')
  assert.equal(chain.version, 3)

  // Diagnostic on `one` (offsets 0…3 at version 0): shifted by edit 1.
  const one = chain.mapRange({
    start: {line: 1, column: 1, offset: 0},
    end: {line: 1, column: 4, offset: 3}
  })
  assert.ok(one)
  assert.deepEqual(one.start, {line: 1, column: 4, offset: 3, byteOffset: 3})
  assert.deepEqual(one.end, {line: 1, column: 7, offset: 6, byteOffset: 6})

  // Diagnostic on the emoji (offsets 8…10 at version 0): shifted by
  // edits 1 and 2, still line 2, columns in UTF-16 units.
  const face = chain.mapRange({
    start: {line: 2, column: 5, offset: 8},
    end: {line: 2, column: 7, offset: 10}
  })
  assert.ok(face)
  assert.deepEqual(face.start, {line: 2, column: 3, offset: 9, byteOffset: 9})
  assert.deepEqual(face.end, {line: 2, column: 5, offset: 11, byteOffset: 13})

  // Diagnostic on `two` (offsets 4…7 at version 0): replaced by edit 2.
  assert.equal(
    chain.mapRange({
      start: {line: 2, column: 1, offset: 4},
      end: {line: 2, column: 4, offset: 7}
    }),
    null
  )

  // Diagnostic on `three` (offsets 11…17 at version 0): deleted by edit 3.
  assert.equal(
    chain.mapRange({
      start: {line: 3, column: 1, offset: 11},
      end: {line: 3, column: 6, offset: 16}
    }),
    null
  )
})

test('the chain is bound to versions', () => {
  const chain = createChangeChain('abc', {version: 42})
  assert.equal(chain.baseVersion, 42)
  assert.equal(chain.version, 42)
  chain.apply({start: 0, end: 0, replacement: '>> '})
  chain.apply({start: 5, end: 6, replacement: 'B'})
  assert.equal(chain.version, 44)
  assert.equal(chain.value, '>> abB')
  assert.equal(chain.valueAt(42), 'abc')
  assert.equal(chain.valueAt(43), '>> abc')

  // A point captured at version 43 (post-first-edit coordinates):
  // `a` sits before the second edit and survives.
  const point = chain.mapPoint({offset: 3}, 43)
  assert.ok(point)
  assert.equal(point.offset, 3)
  assert.equal(chain.value.charAt(point.offset), 'a')
  // A point on `c` (offset 5 at version 43), which edit 2 replaced.
  assert.equal(chain.mapPoint({offset: 5}, 43), null)

  // Versions outside the chain are rejected.
  assert.throws(() => chain.mapPoint({offset: 0}, 41), RangeError)
  assert.throws(() => chain.mapPoint({offset: 0}, 45), RangeError)
  assert.throws(() => chain.valueAt(45), RangeError)
})

test('messages map to a new view; the old file is never mutated', () => {
  const base = 'one\ntwo\nthree\n'
  const chain = createChangeChain(base)
  chain.apply({start: 0, end: 0, replacement: '>> '})
  chain.apply({start: 11, end: 16, replacement: ''})

  const file = {
    value: base,
    messages: [
      {
        message: 'on one',
        line: 1,
        column: 1,
        place: {
          start: {line: 1, column: 1, offset: 0},
          end: {line: 1, column: 4, offset: 3}
        }
      },
      {
        message: 'on three',
        line: 3,
        column: 1,
        place: {
          start: {line: 3, column: 1, offset: 8},
          end: {line: 3, column: 6, offset: 13}
        }
      },
      {message: 'no place'}
    ]
  }
  const snapshot = JSON.stringify(file)

  const view = chain.mapFile(file)

  // The old file and its messages are untouched.
  assert.equal(JSON.stringify(file), snapshot)
  assert.equal(file.value, base)
  assert.equal(file.messages[0].place.start.offset, 0)

  // The view carries the new value and new message objects.
  assert.notEqual(view, file)
  assert.equal(view.value, '>> one\ntwo\n\n')
  assert.notEqual(view.messages, file.messages)
  assert.equal(view.messages.length, 3)
  assert.notEqual(view.messages[0], file.messages[0])

  // Mapped message: shifted place and mirrored line/column.
  assert.equal(view.messages[0].place.start.offset, 3)
  assert.equal(view.messages[0].line, 1)
  assert.equal(view.messages[0].column, 4)
  assert.equal(view.messages[0].deleted, undefined)

  // Deleted message: marked, not dropped, and not mutated in place.
  assert.equal(view.messages[1].place, null)
  assert.equal(view.messages[1].deleted, true)
  assert.equal(view.messages[1].line, null)
  assert.equal(view.messages[1].column, null)
  assert.equal(file.messages[1].deleted, undefined)

  // Messages without a place pass through (as new objects).
  assert.equal(view.messages[2].message, 'no place')
  assert.equal(view.messages[2].place, undefined)
})

test('mapMessages maps a standalone message list', () => {
  const chain = createChangeChain('ab\ncd\n')
  chain.apply({start: 3, end: 5, replacement: ''})
  const messages = chain.mapMessages([
    {message: 'x', place: {line: 2, column: 1, offset: 3}}
  ])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].place, null)
  assert.equal(messages[0].deleted, true)
})

test('ChangeChain can be constructed directly', () => {
  const chain = new ChangeChain('abc')
  assert.equal(chain.version, 0)
  chain.apply({start: 1, end: 2, replacement: 'B'})
  assert.equal(chain.value, 'aBc')
  assert.deepEqual(chain.edits, [{start: 1, end: 2, replacement: 'B'}])
})
