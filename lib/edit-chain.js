/**
 * @typedef {object} TextEdit
 *   A single explicit text change.
 *
 *   Edits are located by **post-execution state**: `offset`/`endOffset` are
 *   UTF-16 code unit offsets into the text *after* all previously pushed
 *   edits of the chain have been applied.
 * @property {number} offset
 *   Start of the replaced range (inclusive, UTF-16 code units).
 * @property {number} endOffset
 *   End of the replaced range (exclusive, UTF-16 code units).
 *   Equal to `offset` for a pure insertion.
 * @property {string} text
 *   Replacement text (empty string for a pure deletion).
 *
 * @typedef {object} Point
 *   A place in text. Lines and columns are 1-based. Columns count UTF-16
 *   code units (never bytes), so an emoji such as a pile of poo is 2 columns.
 * @property {number} line
 *   1-based line.
 * @property {number} column
 *   1-based column, in UTF-16 code units.
 *
 * @typedef {object} Range
 *   A range in text, spanning one or more lines.
 * @property {Point} start
 *   Start (inclusive).
 * @property {Point} end
 *   End (exclusive).
 *
 * @typedef {object} MappedOffset
 *   Result of mapping one offset through a chain.
 * @property {number} offset
 *   Offset in the current (latest) text of the chain.
 * @property {boolean} deleted
 *   Whether the position fell inside text that was deleted or replaced.
 * @property {number} version
 *   Chain version the result is bound to (the version at map time).
 *
 * @typedef {object} MappedPoint
 *   Result of mapping one point through a chain.
 * @property {number} line
 *   1-based line in the current text.
 * @property {number} column
 *   1-based column (UTF-16 code units) in the current text.
 * @property {boolean} deleted
 *   Whether the position fell inside text that was deleted or replaced.
 * @property {number} version
 *   Chain version the result is bound to.
 *
 * @typedef {object} MappedRange
 *   Result of mapping one range through a chain.
 * @property {Point} start
 *   Start in the current text.
 * @property {Point} end
 *   End in the current text.
 * @property {boolean} deleted
 *   Whether the range intersects text that was deleted or replaced.
 * @property {number} version
 *   Chain version the result is bound to.
 */

/**
 * An explicit, ordered chain of text edits with version binding.
 *
 * The chain starts at version `0` (the original text). Each pushed edit
 * bumps the version by one and is located by post-execution state: its
 * offsets refer to the text after all earlier edits were applied.
 *
 * Mapping is purely structural (offset arithmetic); it never guesses by
 * searching for identical words in the new text.
 *
 * Overlapping edits are rejected: a new edit may not touch a region that a
 * previous edit already inserted, replaced, or deleted.
 *
 * Columns are always UTF-16 code units; UTF-8 byte offsets are handled
 * separately through `mapByteOffset`.
 */
export class EditChain {
  /**
   * @param {string} text
   *   Original text (chain version `0`).
   */
  constructor(text) {
    /** @type {Array<string>} text snapshot per version. */
    this._texts = [String(text)]
    /** @type {Array<TextEdit>} applied edits; index `i` leads v`i` -> v`i + 1`. */
    this._edits = []
    /**
     * Regions of the current text already affected by earlier edits,
     * as half-open `[start, end)` pairs in current coordinates
     * (`start === end` marks the collapsed site of a deletion).
     *
     * @type {Array<{start: number, end: number}>}
     */
    this._touched = []
  }

  /**
   * Current chain version (number of applied edits).
   *
   * @returns {number}
   */
  get version() {
    return this._edits.length
  }

  /**
   * Current text (after all edits).
   *
   * @returns {string}
   */
  get text() {
    return this._texts[this._texts.length - 1]
  }

  /**
   * Text at a specific version.
   *
   * @param {number} version
   *   Version (`0` is the original text).
   * @returns {string}
   */
  textAt(version) {
    this._assertVersion(version)
    return this._texts[version]
  }

  /**
   * Append an edit to the chain.
   *
   * The edit is located by post-execution state: `offset`/`endOffset` refer
   * to the current text. Overlapping an earlier edit region throws before
   * anything is applied.
   *
   * @param {TextEdit} edit
   *   Edit to apply.
   * @returns {number}
   *   The new chain version.
   */
  push(edit) {
    const offset = edit.offset
    const endOffset = edit.endOffset
    const text = String(edit.text)
    const current = this.text

    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(endOffset) ||
      offset < 0 ||
      offset > endOffset ||
      endOffset > current.length
    ) {
      throw new RangeError(
        'Edit out of bounds: `offset`/`endOffset` must satisfy ' +
          '`0 <= offset <= endOffset <= text.length`'
      )
    }

    if (offset === endOffset && text.length === 0) {
      throw new Error('Empty edit: nothing would change')
    }

    // Reject overlapping edits first, before applying anything.
    for (const region of this._touched) {
      if (offset < region.end && endOffset > region.start) {
        throw new Error(
          'Overlapping edit: [' +
            offset +
            ', ' +
            endOffset +
            ') intersects a previously edited region [' +
            region.start +
            ', ' +
            region.end +
            ')'
        )
      }
    }

    const delta = text.length - (endOffset - offset)

    // Shift later touched regions; earlier ones are untouched (no overlap).
    for (const region of this._touched) {
      if (region.start >= endOffset) {
        region.start += delta
        region.end += delta
      }
    }

    this._touched.push(
      text.length > 0
        ? {start: offset, end: offset + text.length}
        : {start: offset, end: offset}
    )

    this._edits.push({offset, endOffset, text})
    this._texts.push(
      current.slice(0, offset) + text + current.slice(endOffset)
    )

    return this.version
  }

  /**
   * Map a UTF-16 offset from the text at `fromVersion` to the current text.
   *
   * @param {number} offset
   *   UTF-16 code unit offset in the text at `fromVersion`.
   * @param {number} [fromVersion=0]
   *   Version the offset refers to.
   * @returns {MappedOffset}
   *   Mapped offset, bound to the current chain version.
   */
  mapOffset(offset, fromVersion = 0) {
    this._assertVersion(fromVersion)
    const base = this._texts[fromVersion]

    if (!Number.isInteger(offset) || offset < 0 || offset > base.length) {
      throw new RangeError('Offset out of bounds for version ' + fromVersion)
    }

    const result = this._mapOffsetThrough(offset, fromVersion)
    return {
      offset: result.offset,
      deleted: result.deleted,
      version: this.version
    }
  }

  /**
   * Map a UTF-8 byte offset from the text at `fromVersion` to the current
   * text.
   *
   * Byte offsets are handled separately from UTF-16 columns: this is the
   * only API that speaks bytes. The byte offset must fall on a UTF-8
   * character boundary.
   *
   * @param {number} byteOffset
   *   UTF-8 byte offset in the text at `fromVersion`.
   * @param {number} [fromVersion=0]
   *   Version the offset refers to.
   * @returns {MappedOffset}
   *   Mapped UTF-8 byte offset, bound to the current chain version.
   */
  mapByteOffset(byteOffset, fromVersion = 0) {
    this._assertVersion(fromVersion)
    const u16 = byteOffsetToU16(this._texts[fromVersion], byteOffset)
    const result = this._mapOffsetThrough(u16, fromVersion)
    return {
      offset: u16ToByteOffset(this.text, result.offset),
      deleted: result.deleted,
      version: this.version
    }
  }

  /**
   * Map a point (1-based line, 1-based UTF-16 column) from the text at
   * `fromVersion` to the current text.
   *
   * @param {Point} point
   *   Point in the text at `fromVersion`.
   * @param {number} [fromVersion=0]
   *   Version the point refers to.
   * @returns {MappedPoint}
   *   Mapped point, bound to the current chain version.
   */
  mapPoint(point, fromVersion = 0) {
    this._assertVersion(fromVersion)
    const offset = pointToOffset(this._texts[fromVersion], point)
    const result = this._mapOffsetThrough(offset, fromVersion)
    const mapped = offsetToPoint(this.text, result.offset)
    return {
      line: mapped.line,
      column: mapped.column,
      deleted: result.deleted,
      version: this.version
    }
  }

  /**
   * Map a (possibly multi-line) range from the text at `fromVersion` to the
   * current text.
   *
   * The range is marked `deleted` if it intersects any deleted or replaced
   * text. CRLF sequences and line structure are preserved because edits are
   * pure string splices.
   *
   * @param {Range} range
   *   Range in the text at `fromVersion`.
   * @param {number} [fromVersion=0]
   *   Version the range refers to.
   * @returns {MappedRange}
   *   Mapped range, bound to the current chain version.
   */
  mapRange(range, fromVersion = 0) {
    this._assertVersion(fromVersion)
    const base = this._texts[fromVersion]
    let start = pointToOffset(base, range.start)
    let end = pointToOffset(base, range.end)

    if (start > end) {
      throw new RangeError('Range start must not be after range end')
    }

    let deleted = false

    for (let index = fromVersion; index < this._edits.length; index++) {
      const edit = this._edits[index]

      // Non-empty replaced range intersecting `[start, end)` -> deleted.
      // A point range counts as deleted from the start of replaced text.
      if (
        edit.endOffset > edit.offset &&
        ((start < edit.endOffset && end > edit.offset) ||
          (start === end && start >= edit.offset && start < edit.endOffset))
      ) {
        deleted = true
      }

      start = mapOffsetThroughEdit(start, edit).offset
      end = mapOffsetThroughEdit(end, edit).offset
    }

    return {
      start: offsetToPoint(this.text, start),
      end: offsetToPoint(this.text, end),
      deleted,
      version: this.version
    }
  }

  /**
   * Map one offset through edits `fromVersion..version`.
   *
   * @param {number} offset
   *   Offset in the text at `fromVersion`.
   * @param {number} fromVersion
   *   Version to start from.
   * @returns {{offset: number, deleted: boolean}}
   *   Offset in the current text and whether it was deleted.
   */
  _mapOffsetThrough(offset, fromVersion) {
    let current = offset
    let deleted = false

    for (let index = fromVersion; index < this._edits.length; index++) {
      const result = mapOffsetThroughEdit(current, this._edits[index])
      current = result.offset
      deleted = deleted || result.deleted
    }

    return {offset: current, deleted}
  }

  /**
   * @param {number} version
   *   Version to check.
   * @returns {void}
   */
  _assertVersion(version) {
    if (!Number.isInteger(version) || version < 0 || version > this.version) {
      throw new RangeError(
        'Unknown version ' +
          version +
          ': expected an integer between 0 and ' +
          this.version
      )
    }
  }
}

/**
 * Create a new view of messages with positions mapped through `chain`.
 *
 * The old file and its messages are never mutated: a fresh array of fresh
 * message objects (same prototype, copied fields) is returned. Messages
 * whose position falls inside deleted or replaced text are kept but marked
 * with `deleted: true`.
 *
 * @param {{messages: Array<object>} | Array<object>} file
 *   A vfile-like object with `messages`, or a bare array of messages.
 * @param {EditChain} chain
 *   Edit chain to map through.
 * @param {number} [fromVersion=0]
 *   Chain version the message positions refer to.
 * @returns {Array<object>}
 *   New message objects with positions bound to the current chain version.
 */
export function mapMessages(file, chain, fromVersion = 0) {
  const messages = Array.isArray(file) ? file : file.messages
  const version = chain.version

  return messages.map(function (message) {
    const copy = Object.assign(
      Object.create(Object.getPrototypeOf(message)),
      message
    )
    let deleted = false

    const place = /** @type {any} */ (message).place

    if (place && typeof place === 'object') {
      if (isPoint(place.start) && isPoint(place.end)) {
        const mapped = chain.mapRange(
          {start: cleanPoint(place.start), end: cleanPoint(place.end)},
          fromVersion
        )
        copy.place = {start: mapped.start, end: mapped.end}
        copy.line = mapped.start.line
        copy.column = mapped.start.column
        deleted = deleted || mapped.deleted
      } else if (isPoint(place)) {
        const mapped = chain.mapPoint(cleanPoint(place), fromVersion)
        copy.place = {line: mapped.line, column: mapped.column}
        copy.line = mapped.line
        copy.column = mapped.column
        deleted = deleted || mapped.deleted
      }
    } else if (
      typeof message.line === 'number' &&
      typeof message.column === 'number'
    ) {
      const mapped = chain.mapPoint(
        {line: message.line, column: message.column},
        fromVersion
      )
      copy.line = mapped.line
      copy.column = mapped.column
      deleted = deleted || mapped.deleted
    }

    if (typeof message.offset === 'number') {
      const mapped = chain.mapOffset(message.offset, fromVersion)
      copy.offset = mapped.offset
      deleted = deleted || mapped.deleted
    }

    if (deleted) {
      copy.deleted = true
    }

    // Bind the mapped view to the chain version it was created from.
    copy.version = version

    return copy
  })
}

/**
 * Map one offset through one edit.
 *
 * Boundary convention: a position at an insertion point stays before the
 * inserted text; a position exactly at the end of a replaced range clamps
 * to just after the replacement; a position at the start of, or inside,
 * deleted or replaced text is marked deleted (the character there is gone)
 * and clamps into the replacement.
 *
 * @param {number} offset
 *   Offset in the pre-edit text.
 * @param {TextEdit} edit
 *   Edit to map through.
 * @returns {{offset: number, deleted: boolean}}
 *   Offset in the post-edit text and whether it was deleted.
 */
function mapOffsetThroughEdit(offset, edit) {
  const start = edit.offset
  const end = edit.endOffset

  if (offset < start) {
    return {offset, deleted: false}
  }

  if (offset === start) {
    // Pure insertion point: stay before the inserted text.
    // Start of deleted/replaced text: the character here is gone.
    return {offset: start, deleted: start !== end}
  }

  if (offset < end) {
    // Inside replaced text: clamp into the replacement, mark deleted.
    return {
      offset: start + Math.min(offset - start, edit.text.length),
      deleted: true
    }
  }

  if (offset === end) {
    return {offset: start + edit.text.length, deleted: false}
  }

  return {offset: offset + edit.text.length - (end - start), deleted: false}
}

/**
 * Line starts of `text`; CRLF, CR, and LF all count as one ending,
 * so CRLF is preserved as a single line boundary.
 *
 * @param {string} text
 *   Text to scan.
 * @returns {Array<number>}
 *   UTF-16 offsets at which each line starts.
 */
function lineStarts(text) {
  const starts = [0]
  const expression = /\r\n|[\n\r]/g
  let match

  while ((match = expression.exec(text)) !== null) {
    starts.push(match.index + match[0].length)
  }

  return starts
}

/**
 * @param {string} text
 *   Text the point refers to.
 * @param {Point} point
 *   1-based line/column (UTF-16 code units).
 * @returns {number}
 *   UTF-16 offset.
 */
function pointToOffset(text, point) {
  const starts = lineStarts(text)
  const line = point.line
  const column = point.column

  if (!Number.isInteger(line) || line < 1 || line > starts.length) {
    throw new RangeError('Unknown line ' + line)
  }

  if (!Number.isInteger(column) || column < 1) {
    throw new RangeError('Unknown column ' + column)
  }

  const offset = starts[line - 1] + column - 1
  const max = line < starts.length ? starts[line] : text.length

  if (offset > max) {
    throw new RangeError('Column ' + column + ' out of bounds on line ' + line)
  }

  return offset
}

/**
 * @param {string} text
 *   Text the offset refers to.
 * @param {number} offset
 *   UTF-16 offset.
 * @returns {Point}
 *   1-based line/column (UTF-16 code units).
 */
function offsetToPoint(text, offset) {
  const starts = lineStarts(text)
  let low = 0
  let high = starts.length - 1

  while (low < high) {
    const middle = (low + high + 1) >> 1

    if (starts[middle] <= offset) {
      low = middle
    } else {
      high = middle - 1
    }
  }

  return {line: low + 1, column: offset - starts[low] + 1}
}

/**
 * @param {number} codePoint
 *   Unicode code point.
 * @returns {number}
 *   Number of UTF-8 bytes.
 */
function utf8ByteLength(codePoint) {
  return codePoint < 0x80
    ? 1
    : codePoint < 0x800
      ? 2
      : codePoint < 0x10_000
        ? 3
        : 4
}

/**
 * @param {string} text
 *   Text the offset refers to.
 * @param {number} u16Offset
 *   UTF-16 code unit offset.
 * @returns {number}
 *   UTF-8 byte offset.
 */
function u16ToByteOffset(text, u16Offset) {
  let bytes = 0

  for (const character of text.slice(0, u16Offset)) {
    bytes += utf8ByteLength(character.codePointAt(0))
  }

  return bytes
}

/**
 * @param {string} text
 *   Text the offset refers to.
 * @param {number} byteOffset
 *   UTF-8 byte offset (must be on a character boundary).
 * @returns {number}
 *   UTF-16 code unit offset.
 */
function byteOffsetToU16(text, byteOffset) {
  if (!Number.isInteger(byteOffset) || byteOffset < 0) {
    throw new RangeError('Byte offset must be a non-negative integer')
  }

  let bytes = 0
  let u16 = 0

  for (const character of text) {
    if (bytes === byteOffset) {
      return u16
    }

    const size = utf8ByteLength(character.codePointAt(0))

    if (bytes + size > byteOffset) {
      throw new RangeError(
        'Byte offset ' + byteOffset + ' is not on a UTF-8 character boundary'
      )
    }

    bytes += size
    u16 += character.length
  }

  if (bytes === byteOffset) {
    return u16
  }

  throw new RangeError('Byte offset ' + byteOffset + ' out of bounds')
}

/**
 * @param {unknown} value
 *   Value to check.
 * @returns {boolean}
 *   Whether `value` looks like a unist point.
 */
function isPoint(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof /** @type {Point} */ (value).line === 'number' &&
    typeof /** @type {Point} */ (value).column === 'number'
  )
}

/**
 * @param {Point} point
 *   Point-like value.
 * @returns {Point}
 *   Plain line/column point.
 */
function cleanPoint(point) {
  return {line: point.line, column: point.column}
}
