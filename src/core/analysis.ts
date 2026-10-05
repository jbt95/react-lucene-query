/** Local analysis only: Unicode letters/digits, lowercase, and consecutive token positions. */
export function analyzeText(text: string): readonly string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/** Unicode scalar ordering agrees with UTF-8 ordering, unlike UTF-16 string comparison. */
export function compareTerms(actual: string, expected: string): number {
  let left = 0
  let right = 0

  while (left < actual.length && right < expected.length) {
    const a = actual.codePointAt(left)!
    const b = expected.codePointAt(right)!

    if (a !== b) return a < b ? -1 : 1
    left += a > 0xffff ? 2 : 1
    right += b > 0xffff ? 2 : 1
  }

  if (left < actual.length) return 1

  if (right < expected.length) return -1

  return 0
}

/** `number` fields index numeric values; unparseable text is unindexed rather than a mismatch. */
export function parseNumber(text: string): number | undefined {
  const trimmed = text.trim()

  if (trimmed === '') return undefined
  const value = Number(trimmed)

  return Number.isNaN(value) ? undefined : value
}

/** How precisely a date literal was written, which decides the window it covers. */
export type DatePrecision = 'year' | 'month' | 'day' | 'second' | 'millisecond'

/** The half-open instant range `[from, to)` that one written date covers. */
export type DateWindow = {
  readonly from: number
  readonly to: number
  readonly precision: DatePrecision
}

const DAY = 86_400_000

// `2026`, `2026-10`, `2026-10-24`, and `2026-10-24T09:30[:00[.123]][Z|±HH:MM]`; a missing zone
// is read as UTC so the same text always denotes the same instant.
const DATE_PATTERN =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/

function utc(year: number, month: number, day: number): number {
  const date = new Date(0)

  // setUTCFullYear avoids the two-digit year remapping that Date.UTC applies below 100.
  date.setUTCFullYear(year, month, day)
  date.setUTCHours(0, 0, 0, 0)

  return date.getTime()
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

function isRealDay(year: number, monthIndex: number, day: number): boolean {
  const written = new Date(utc(year, monthIndex, day))

  return (
    written.getUTCFullYear() === year &&
    written.getUTCMonth() === monthIndex &&
    written.getUTCDate() === day
  )
}

function isClockPart(value: number | undefined, limit: number): boolean {
  return value !== undefined && value >= 0 && value < limit
}

/** Parses one date literal into the window it covers, or nothing when the text is not a date. */
export function parseDate(text: string): DateWindow | undefined {
  const match = DATE_PATTERN.exec(text.trim())

  if (!match) return undefined

  const year = Number(match[1])
  const month = match[2] === undefined ? undefined : Number(match[2])
  const day = match[3] === undefined ? undefined : Number(match[3])

  // Written months are 1-based; every instant below is computed from a 0-based index.
  if (month !== undefined && (month < 1 || month > 12)) return undefined

  const monthIndex = month === undefined ? 0 : month - 1

  if (month === undefined)
    return { from: utc(year, 0, 1), to: utc(year + 1, 0, 1), precision: 'year' }

  if (day === undefined)
    return { from: utc(year, monthIndex, 1), to: utc(year, monthIndex + 1, 1), precision: 'month' }

  if (day < 1 || day > 31 || !isRealDay(year, monthIndex, day)) return undefined

  const hour = match[4] === undefined ? undefined : Number(match[4])

  if (hour === undefined) {
    const from = utc(year, monthIndex, day)

    return { from, to: from + DAY, precision: 'day' }
  }

  const minute = Number(match[5])
  const second = match[6] === undefined ? 0 : Number(match[6])
  const millisecond = match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0'))
  const zone = match[8] ?? 'Z'

  if (!isClockPart(hour, 24) || !isClockPart(minute, 60) || !isClockPart(second, 60)) {
    return undefined
  }

  const offset = zone === 'Z' || zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`

  const instant = Date.parse(
    `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(millisecond, 3)}${offset}`,
  )

  if (Number.isNaN(instant)) return undefined

  return {
    from: instant,
    to: instant + (match[7] === undefined ? 1000 : 1),
    precision: match[7] === undefined ? 'second' : 'millisecond',
  }
}
