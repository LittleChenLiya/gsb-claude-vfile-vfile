/**
 * Three-edit example for explicit text-change position mapping.
 *
 * Run with:
 *
 *     node examples/three-edits.js
 *
 * The chain below applies three edits, each located by post-execution
 * state (its offsets refer to the text after the previous edits), then
 * maps diagnostics from the original text (version 0) into the new text.
 */
import {EditChain, mapMessages} from '../lib/edit-chain.js'

// Original text: CRLF line endings, an emoji on line 1, an error on line 3.
const original = 'fix \u{1F4A9} bug\r\nkeep this line\r\nbad error here\r\n'

const chain = new EditChain(original)
console.log('version 0 (original):')
console.log(JSON.stringify(chain.text))

// Edit 1: insert `>> ` at the start of the first line.
chain.push({offset: 0, endOffset: 0, text: '>> '})
console.log('\nversion', chain.version, '(after insert at line 1 start):')
console.log(JSON.stringify(chain.text))

// Edit 2: delete the text that contains the error (`bad error here`),
// addressed in the state *after* edit 1.
const state1 = chain.text
const badAt = state1.indexOf('bad error here')
chain.push({offset: badAt, endOffset: badAt + 'bad error here'.length, text: ''})
console.log('\nversion', chain.version, '(after deleting the error text):')
console.log(JSON.stringify(chain.text))

// Edit 3: insert `!` right after the emoji (2 UTF-16 code units, 4 bytes),
// addressed in the state *after* edit 2.
const state2 = chain.text
const afterEmoji = state2.indexOf('\u{1F4A9}') + 2
chain.push({offset: afterEmoji, endOffset: afterEmoji, text: '!'})
console.log('\nversion', chain.version, '(after inserting after the emoji):')
console.log(JSON.stringify(chain.text))

// Diagnostics recorded against the original text (version 0).
// Columns are UTF-16 code units: the emoji takes columns 5-6 on line 1,
// so `bug` starts at column 8 (not column 10 as bytes would suggest).
const file = {
  messages: [
    {
      reason: 'bug on line 1',
      line: 1,
      column: 8,
      offset: 7,
      fatal: false,
      place: {start: {line: 1, column: 8}, end: {line: 1, column: 11}}
    },
    {
      reason: 'error on line 3',
      line: 3,
      column: 8,
      offset: original.indexOf('error'),
      fatal: true,
      place: {start: {line: 3, column: 5}, end: {line: 3, column: 10}}
    }
  ]
}

// Map the diagnostics to the current text (version 3). The old file and
// its messages are not mutated; a fresh view is returned.
const view = mapMessages(file, chain, 0)

console.log('\nmapped messages (bound to version', chain.version + '):')
for (const message of view) {
  console.log(
    '-',
    JSON.stringify(message.reason),
    'at',
    message.line + ':' + message.column,
    'offset',
    message.offset,
    message.deleted ? 'DELETED' : 'mapped',
    'place',
    JSON.stringify(message.place)
  )
}

console.log('\noriginal messages untouched:')
for (const message of file.messages) {
  console.log(
    '-',
    JSON.stringify(message.reason),
    'at',
    message.line + ':' + message.column,
    'offset',
    message.offset
  )
}

// Byte offsets are handled separately from UTF-16 columns.
const byteMapped = chain.mapByteOffset(9, 0) // byte offset of `bug` in v0
console.log('\nbyte offset 9 (of `bug`, version 0) maps to byte offset', byteMapped.offset)
