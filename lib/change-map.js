/**
 * @typedef {object} ChangeMapEdit
 *   A single text change.
 *
 *   Offsets are 0-based UTF-16 code unit indices (JavaScript string
 *   indices) and are located against the document state *after* all
 *   previously chained edits have been applied (the chain locates edits
 *   against the post-execution state).
 * @property {number} start
 *   Start of the replaced range (inclusive, UTF-16 code units).
 * @property {number} end
 *   End of the replaced range (exclusive, UTF-16 code units).
 *   Use `start === end` for a pure insertion and an empty `replacement`
 *   for a pure deletion.
 * @property {string} replacement
 *   Text that replaces the range.
 *
 * @typedef {object} ChangeMapPoint
 *   A place in a text file.
 *
 *   `line`/`column` are 1-based; `column` counts UTF-16 code units (so
 *   an emoji such as U+1F600 is 2 columns, **not** 4 bytes). `offset`
 *   is a 0-based UTF-16 code unit index. `byteOffset` is a 0-based
 *   UTF-8 byte index. Columns and byte offsets are handled separately:
 *   neither is ever derived from the other.
 * @property {number} line
 *   1-based line.
 * @property {number} column
 *   1-based column in UTF-16 code units.
 * @property {number} [offset]
 *   0-based UTF-16 code unit offset (optional on input; when present it
 *   is used verbatim instead of `line`/`column`).
 * @property {number} [byteOffset]
 *   0-based UTF-8 byte offset (only emitted on output).
 *
 * @typedef {object} ChangeMapPosition
 *   A range between two points.
 * @property {ChangeMapPoint} start
 *   Start point.
 * @property {ChangeMapPoint} end
 *   End point.
 *
 * @typedef {object} ChangeMapOptions
 *   Configuration for a change chain.
 * @property {number} [version]
 *   Version the initial value is bound to (default: `0`); every applied
 *   edit bumps the version by one.
 */

// Matches unist `Point`/`Position` and `VFileMessage.place` structurally,
// so messages from `vfile` can be mapped without importing anything.

const encoder = new TextEncoder()

/**
 * Create a change chain bound to an initial value (and optional version).
 *
 * @param {string} value
 *   Initial text.
 * @param {ChangeMapOptions | null | undefined} [options]
 *   Configuration.
 * @returns {ChangeChain}
 *   New change chain.
 */
export function createChangeChain(value, options) {
  return new ChangeChain(value, options)
}

/**
 * An ordered, version-bound chain of explicit text edits that maps
 * diagnostic positions from an old text to the current text — or marks
 * them as deleted.
 *
 * Mapping is pure offset arithmetic through the recorded edits; the chain
 * never guesses by searching for identical words in the new text.
 */
export class ChangeChain {
  /** @type {string} */
  #baseValue
  /** @type {number} */
  #baseVersion
  /** @type {Array<ChangeMapEdit>} */
  #edits = []
  /**
   * Regions touched by earlier edits, in *current* document coordinates.
   * Later edits overlapping these regions are rejected up front.
   *
   * @type {Array<{start: number, end: number}>}
   */
  #touched = []
  /** @type {string} */
  #value

  /**
   * @param {string} value
   *   Initial text.
   * @param {ChangeMapOptions | null | undefined} [options]
   *   Configuration.
   */
  constructor(value, options) {
    this.#baseValue = String(value ?? '')
    this.#value = this.#baseValue
    this.#baseVersion =
      options && typeof options.version === 'number' ? options.version : 0
  }

  /**
   * Version the initial value is bound to.
   *
   * @returns {number}
   *   Base version.
   */
  get baseVersion() {
    return this.#baseVersion
  }

  /**
   * Current version: `baseVersion + number of applied edits`.
   *
   * @returns {number}
   *   Current version.
   */
  get version() {
    return this.#baseVersion + this.#edits.length
  }

  /**
   * Current text (after all chained edits).
   *
   * @returns {string}
   *   Current value.
   */
  get value() {
    return this.#value
  }

  /**
   * Applied edits, in application order, each located against the state
   * after its predecessors.
   *
   * @returns {Array<ChangeMapEdit>}
   *   Copies of the applied edits.
   */
  get edits() {
    return this.#edits.map((edit) => ({...edit}))
  }

  /**
   * Reconstruct the text at any known version.
   *
   * @param {number} version
   *   Version to reconstruct (`baseVersion … version`).
   * @returns {string}
   *   Text at that version.
   */
  valueAt(version) {
    const index = this.#versionIndex(version)
    let value = this.#baseValue
    for (let i = 0; i < index; i++) {
      const edit = this.#edits[i]
      value =
        value.slice(0, edit.start) + edit.replacement + value.slice(edit.end)
    }
    return value
  }

  /**
   * Apply one edit to the chain.
   *
   * The edit is located against the current (post-previous-edits) state.
   * Edits that overlap a region already touched by an earlier edit in the
   * chain are rejected up front.
   *
   * @param {ChangeMapEdit} edit
   *   Edit to apply.
   * @returns {number}
   *   The new version.
   */
  apply(edit) {
    if (!edit || typeof edit !== 'object') {
      throw new TypeError('Expected an edit object')
    }
    const {start, end, replacement} = edit
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.#value.length
    ) {
      throw new RangeError(
        'Edit range [' + start + ', ' + end + ') is out of bounds for value of length ' + this.#value.length
      )
    }
    if (typeof replacement !== 'string') {
      throw new TypeError('Expected `replacement` to be a string')
    }
    for (const region of this.#touched) {
      const overlaps =
        start === end
          ? region.start < start && start < region.end
          : start < region.end && region.start < end
      if (overlaps) {
        throw new RangeError(
          'Overlapping edit rejected: [' + start + ', ' + end + ') intersects previously edited region [' + region.start + ', ' + region.end + ')'
        )
      }
    }

    const delta = replacement.length - (end - start)
    this.#value =
      this.#value.slice(0, start) + replacement + this.#value.slice(end)
    for (const region of this.#touched) {
      if (region.start >= end) {
        region.start += delta
        region.end += delta
      }
    }
    this.#touched.push({start, end: start + replacement.length})
    this.#edits.push({start, end, replacement})
    return this.version
  }

  /**
   * Map a point captured at `fromVersion` to the current version.
   *
   * @param {ChangeMapPoint} point
   *   Point (`line`/`column` or explicit `offset`), in UTF-16 units.
   * @param {number | undefined} [fromVersion]
   *   Version the point was captured at (default: `baseVersion`).
   * @returns {ChangeMapPoint | null}
   *   New point with `line`, `column` (UTF-16), `offset` (UTF-16), and
   *   `byteOffset` (UTF-8 bytes), or `null` when the point fell inside
   *   text that was deleted.
   */
  mapPoint(point, fromVersion) {
    const fromIndex = this.#versionIndex(
      fromVersion === undefined ? this.#baseVersion : fromVersion
    )
    const offset = pointToOffset(
      this.valueAt(this.#baseVersion + fromIndex),
      point
    )
    const mapped = this.#walk(offset, offset, fromIndex, true)
    if (mapped === null) return null
    return offsetToPoint(this.#value, mapped.start)
  }

  /**
   * Map a range captured at `fromVersion` to the current version.
   *
   * @param {ChangeMapPosition} range
   *   Range with `start` and `end` points (multi-line ranges and CRLF
   *   line endings are preserved).
   * @param {number | undefined} [fromVersion]
   *   Version the range was captured at (default: `baseVersion`).
   * @returns {ChangeMapPosition | null}
   *   New range, or `null` when the range intersects text that was
   *   deleted.
   */
  mapRange(range, fromVersion) {
    if (!range || !range.start || !range.end) {
      throw new TypeError('Expected a range with `start` and `end` points')
    }
    const fromIndex = this.#versionIndex(
      fromVersion === undefined ? this.#baseVersion : fromVersion
    )
    const value = this.valueAt(this.#baseVersion + fromIndex)
    const start = pointToOffset(value, range.start)
    const end = pointToOffset(value, range.end)
    if (end < start) {
      throw new RangeError('Expected range `end` to not be before `start`')
    }
    const mapped = this.#walk(start, end, fromIndex, start === end)
    if (mapped === null) return null
    return {
      start: offsetToPoint(this.#value, mapped.start),
      end: offsetToPoint(this.#value, mapped.end)
    }
  }

  /**
   * Map a unist-style place (a point or a position).
   *
   * @param {ChangeMapPoint | ChangeMapPosition} place
   *   Point or range.
   * @param {number | undefined} [fromVersion]
   *   Version the place was captured at (default: `baseVersion`).
   * @returns {ChangeMapPoint | ChangeMapPosition | null}
   *   Mapped place, or `null` when deleted.
   */
  mapPlace(place, fromVersion) {
    if (
      place &&
      typeof place === 'object' &&
      'start' in place &&
      'end' in place &&
      place.start &&
      place.end
    ) {
      return this.mapRange(
        /** @type {ChangeMapPosition} */ (place),
        fromVersion
      )
    }
    return this.mapPoint(/** @type {ChangeMapPoint} */ (place), fromVersion)
  }

  /**
   * Map message-like objects (such as `VFileMessage`s) to the current
   * version.
   *
   * New message objects are returned — the inputs are never mutated;
   * mapping only produces a new view. Messages whose `place` intersects
   * deleted text get `place: null` and `deleted: true`.
   *
   * @template {{place?: ChangeMapPoint | ChangeMapPosition | null | undefined}} Message
   * @param {Array<Message>} messages
   *   Messages captured at `fromVersion`.
   * @param {number | undefined} [fromVersion]
   *   Version the messages were captured at (default: `baseVersion`).
   * @returns {Array<Message>}
   *   New message objects.
   */
  mapMessages(messages, fromVersion) {
    if (!Array.isArray(messages)) {
      throw new TypeError('Expected `messages` to be an array')
    }
    /** @type {Array<Message>} */
    const result = []
    for (const message of messages) {
      const next = Object.assign(
        Object.create(Object.getPrototypeOf(message)),
        message
      )
      if (message.place) {
        const place = this.mapPlace(message.place, fromVersion)
        if (place === null) {
          next.place = null
          // @ts-expect-error: extra marker field on the new view.
          next.deleted = true
          syncMirrors(message, next, null)
        } else {
          next.place = place
          syncMirrors(message, next, place)
        }
      }
      result.push(next)
    }
    return result
  }

  /**
   * Create a new view of a file-like object (`{value, messages}`) at the
   * current version. The original file and its messages are left
   * untouched.
   *
   * @template {{value?: unknown, messages?: Array<any>}} File
   * @param {File} file
   *   File whose messages were captured at `fromVersion`.
   * @param {number | undefined} [fromVersion]
   *   Version the file value/messages correspond to (default:
   *   `baseVersion`).
   * @returns {File}
   *   New view with the current `value` and mapped `messages`.
   */
  mapFile(file, fromVersion) {
    if (!file || typeof file !== 'object') {
      throw new TypeError('Expected a file object')
    }
    const view = Object.assign(
      Object.create(Object.getPrototypeOf(file)),
      file
    )
    view.value = this.#value
    view.messages = this.mapMessages(
      Array.isArray(file.messages) ? file.messages : [],
      fromVersion
    )
    return view
  }

  /**
   * Walk a range (in `fromIndex`-era coordinates) through the remaining
   * edits.
   *
   * @param {number} start
   *   Start offset (UTF-16 code units).
   * @param {number} end
   *   End offset (UTF-16 code units).
   * @param {number} fromIndex
   *   Index of the first edit to map through.
   * @param {boolean} point
   *   Whether this is a zero-length point.
   * @returns {{start: number, end: number} | null}
   *   Mapped offsets, or `null` when the range intersects removed text.
   */
  #walk(start, end, fromIndex, point) {
    let head = start
    let tail = end
    for (let index = fromIndex; index < this.#edits.length; index++) {
      const edit = this.#edits[index]
      const removed = edit.end - edit.start
      const delta = edit.replacement.length - removed
      // The range intersects text removed by this edit: mark deleted.
      // A zero-length point is deleted when it sits on removed text
      // (`[start, end)`); a non-empty range when it overlaps it.
      if (
        removed > 0 &&
        (point
          ? edit.start <= head && head < edit.end
          : head < edit.end && edit.start < tail)
      ) {
        return null
      }
      if (point) {
        head = tail = mapEndpoint(head, edit, delta)
      } else {
        head = mapStart(head, edit, delta)
        tail = mapEnd(tail, edit, delta)
      }
    }
    return {start: head, end: tail}
  }

  /**
   * Resolve and validate a version, returning an edit index. The chain
   * is bound to versions: positions must declare the version they were
   * captured at.
   *
   * @param {number} version
   *   Version to check.
   * @returns {number}
   *   Index into the edit list.
   */
  #versionIndex(version) {
    if (
      !Number.isInteger(version) ||
      version < this.#baseVersion ||
      version > this.version
    ) {
      throw new RangeError(
        'Unknown version ' + version + ': this chain covers versions ' + this.#baseVersion + '…' + this.version
      )
    }
    return version - this.#baseVersion
  }
}

/**
 * Map a range start (or a point) through one edit. Positions exactly at
 * the edit start move to the end of the replacement, so inserting before
 * the first line shifts the original range backwards.
 *
 * @param {number} offset
 *   Offset to map.
 * @param {ChangeMapEdit} edit
 *   Edit to map through.
 * @param {number} delta
 *   `replacement.length - (end - start)`.
 * @returns {number}
 *   Mapped offset.
 */
function mapStart(offset, edit, delta) {
  if (offset < edit.start) return offset
  if (offset === edit.start) return edit.start + edit.replacement.length
  // `offset >= edit.end` (strictly inside was rejected as deleted).
  return offset + delta
}

/**
 * Map a range end through one edit. An end exactly at the edit start
 * stays before the replacement.
 *
 * @param {number} offset
 *   Offset to map.
 * @param {ChangeMapEdit} edit
 *   Edit to map through.
 * @param {number} delta
 *   `replacement.length - (end - start)`.
 * @returns {number}
 *   Mapped offset.
 */
function mapEnd(offset, edit, delta) {
  if (offset <= edit.start) return offset
  // `offset >= edit.end` (strictly inside was rejected as deleted).
  return offset + delta
}

/**
 * Map a zero-length point through one edit.
 *
 * @param {number} offset
 *   Offset to map.
 * @param {ChangeMapEdit} edit
 *   Edit to map through.
 * @param {number} delta
 *   `replacement.length - (end - start)`.
 * @returns {number}
 *   Mapped offset.
 */
function mapEndpoint(offset, edit, delta) {
  return mapStart(offset, edit, delta)
}

/**
 * Compute the offsets at which lines start. CRLF, CR, and LF each count
 * as exactly one line break.
 *
 * @param {string} value
 *   Text to scan.
 * @returns {Array<number>}
 *   UTF-16 offsets at which each line starts.
 */
function lineStartOffsets(value) {
  const starts = [0]
  let index = 0
  while (index < value.length) {
    const code = value.charCodeAt(index)
    if (code === 13 /* CR */) {
      if (value.charCodeAt(index + 1) === 10 /* LF */) index++
      starts.push(index + 1)
    } else if (code === 10 /* LF */) {
      starts.push(index + 1)
    }
    index++
  }
  return starts
}

/**
 * Resolve a point to a UTF-16 offset. An explicit `offset` is used
 * verbatim; otherwise `line`/`column` (1-based, UTF-16 code units) are
 * resolved against the line starts.
 *
 * @param {string} value
 *   Text the point belongs to.
 * @param {ChangeMapPoint} point
 *   Point to resolve.
 * @returns {number}
 *   UTF-16 offset.
 */
function pointToOffset(value, point) {
  if (!point || typeof point !== 'object') {
    throw new TypeError('Expected a point object')
  }
  if (typeof point.offset === 'number') {
    if (
      !Number.isInteger(point.offset) ||
      point.offset < 0 ||
      point.offset > value.length
    ) {
      throw new RangeError(
        'Point offset ' + point.offset + ' is out of bounds for value of length ' + value.length
      )
    }
    return point.offset
  }
  if (!Number.isInteger(point.line) || !Number.isInteger(point.column)) {
    throw new TypeError('Expected a point with `offset` or `line`/`column`')
  }
  const starts = lineStartOffsets(value)
  if (point.line < 1 || point.line > starts.length || point.column < 1) {
    throw new RangeError(
      'Point ' + point.line + ':' + point.column + ' is out of bounds (' + starts.length + ' lines)'
    )
  }
  const offset = starts[point.line - 1] + point.column - 1
  if (offset > value.length) {
    throw new RangeError(
      'Point ' + point.line + ':' + point.column + ' is out of bounds for value of length ' + value.length
    )
  }
  return offset
}

/**
 * Resolve a UTF-16 offset to a full point. `column` counts UTF-16 code
 * units while `byteOffset` counts UTF-8 bytes — computed separately, so
 * an emoji is 2 columns but 4 bytes.
 *
 * @param {string} value
 *   Text the offset belongs to.
 * @param {number} offset
 *   UTF-16 offset.
 * @returns {ChangeMapPoint}
 *   Full point.
 */
function offsetToPoint(value, offset) {
  const starts = lineStartOffsets(value)
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return {
    line: low + 1,
    column: offset - starts[low] + 1,
    offset,
    byteOffset: encoder.encode(value.slice(0, offset)).length
  }
}

/**
 * Mirror `line`/`column` convenience fields on the new message view, but
 * only when the original message carried them as own data properties
 * (so accessor-based classes such as `VFileMessage` are left alone).
 *
 * @param {any} source
 *   Original message.
 * @param {any} next
 *   New message view.
 * @param {ChangeMapPoint | ChangeMapPosition | null} place
 *   Mapped place, or `null` when deleted.
 * @returns {void}
 *   Nothing.
 */
function syncMirrors(source, next, place) {
  const point =
    place && 'start' in place
      ? /** @type {ChangeMapPosition} */ (place).start
      : /** @type {ChangeMapPoint | null} */ (place)
  for (const key of ['line', 'column', 'offset']) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor && 'value' in descriptor) {
      next[key] = point ? point[key] : null
    }
  }
}
