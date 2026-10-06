# Explicit text-change position mapping

`lib/change-map.js` maps diagnostic positions through an **ordered,
version-bound chain of edits**: given positions captured at an old
version of a text, it produces their positions in the new text — or
marks them as deleted. Mapping is explicit offset arithmetic through the
recorded edits; it never guesses by searching for identical words.

## Rules

*   Edits are `{start, end, replacement}` with 0-based UTF-16 code unit
    offsets, each located against the state **after** all previous edits
    in the chain (链按执行后状态定位).
*   Overlapping edits (touching a region an earlier edit already
    touched) are rejected up front with a `RangeError`.
*   `column` counts UTF-16 code units and `byteOffset` counts UTF-8
    bytes; the two are computed separately, so an emoji is 2 columns but
    4 bytes (emoji 列不按字节算).
*   CRLF (`\r\n`), CR, and LF line breaks and multi-line ranges are
    preserved.
*   A range (or point) that intersects removed text maps to `null`
    (deleted); mapped messages get `place: null` and `deleted: true`.
*   The chain is version-bound: it starts at `baseVersion` (default 0),
    every `apply()` bumps the version, and positions must declare the
    version they were captured at (`mapPoint`/`mapRange`/`mapFile` take
    `fromVersion`).
*   `mapMessages`/`mapFile` only produce **new views** — new message
    objects and a new file view; the old VFile and its messages are
    never mutated in place.

## Node command

Run the tests:

```sh
node --test test-change-map.js
```

Run the three-edit example:

```sh
node example-change-map.js
```

## Three-edit example

```js
import {createChangeChain} from './lib/change-map.js'

const base = 'one\ntwo \u{1F600}\nthree\n'
const chain = createChangeChain(base)

// Each edit is located against the state after the previous edits:
chain.apply({start: 0, end: 0, replacement: '>> '})  // insert before first line
chain.apply({start: 7, end: 10, replacement: '2'})   // `two` -> `2` (post-edit-1 offsets)
chain.apply({start: 12, end: 17, replacement: ''})   // delete `three` (post-edit-2 offsets)

const view = chain.mapFile({
  value: base,
  messages: [
    {message: 'on one', place: {start: {line: 1, column: 1, offset: 0}, end: {line: 1, column: 4, offset: 3}}},
    {message: 'on emoji', place: {start: {line: 2, column: 5, offset: 8}, end: {line: 2, column: 7, offset: 10}}},
    {message: 'on three', place: {start: {line: 3, column: 1, offset: 11}, end: {line: 3, column: 6, offset: 16}}}
  ]
})
```

Output of `node example-change-map.js`:

```text
version: 0 -> 3
new text:
>> one
2 😀

issue on `one` -> 1:4 (offset 3, byte 3) … 1:7 (offset 6, byte 6)
issue on the emoji -> 2:3 (offset 9, byte 9) … 2:5 (offset 11, byte 13)
issue on `three` -> DELETED
original file untouched: true
```

*   Inserting `>> ` before the first line shifts the `one` range from
    offsets 0…3 to 3…6 (第一行前插字符后原范围正确后移).
*   The emoji range keeps UTF-16 columns (3…5) while its byte offsets
    are 9…13 — columns are not counted by bytes.
*   The `three` diagnostic falls inside deleted text and is marked
    `DELETED` (删除包含错误的文本标删除).
