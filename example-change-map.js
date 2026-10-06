/**
 * Three-edit example for explicit text-change position mapping.
 *
 * Run with:
 *
 *     node example-change-map.js
 *
 * Each edit is located against the state *after* the previous edits
 * (链按执行后状态定位). Original diagnostics are mapped to the new text
 * or marked as deleted — purely by offset arithmetic, never by searching
 * for identical words.
 */

import {createChangeChain} from './lib/change-map.js'

const emoji = '\u{1F600}'

// Original text (version 0) and diagnostics captured at version 0.
const base = 'one\ntwo ' + emoji + '\nthree\n'
const file = {
  value: base,
  messages: [
    {
      message: 'issue on `one`',
      place: {
        start: {line: 1, column: 1, offset: 0},
        end: {line: 1, column: 4, offset: 3}
      }
    },
    {
      message: 'issue on the emoji',
      place: {
        start: {line: 2, column: 5, offset: 8},
        end: {line: 2, column: 7, offset: 10}
      }
    },
    {
      message: 'issue on `three`',
      place: {
        start: {line: 3, column: 1, offset: 11},
        end: {line: 3, column: 6, offset: 16}
      }
    }
  ]
}

const chain = createChangeChain(base)

// Edit 1: insert `>> ` before the first line.
chain.apply({start: 0, end: 0, replacement: '>> '})
// Edit 2: replace `two`, located at offsets 7…10 in the *new* state.
chain.apply({start: 7, end: 10, replacement: '2'})
// Edit 3: delete `three`, located at offsets 12…17 in the *new* state.
chain.apply({start: 12, end: 17, replacement: ''})

console.log('version: %d -> %d', chain.baseVersion, chain.version)
console.log('new text:\n' + chain.value)

// A new view: the original `file` and its messages are not mutated.
const view = chain.mapFile(file)
for (const message of view.messages) {
  if (message.deleted) {
    console.log('%s -> DELETED', message.message)
  } else {
    const {start, end} = message.place
    console.log(
      '%s -> %d:%d (offset %d, byte %d) … %d:%d (offset %d, byte %d)',
      message.message,
      start.line,
      start.column,
      start.offset,
      start.byteOffset,
      end.line,
      end.column,
      end.offset,
      end.byteOffset
    )
  }
}
console.log('original file untouched:', file.value === base)
