import { Temporal } from '@js-temporal/polyfill'
import { parseIsoDate } from './date'
import type { DiagnosticSeverity, TokenRole } from './query-types'

export type QueryFieldType = 'text' | 'number' | 'date' | 'boolean' | 'enum'

export type QueryFieldValue = string | number | boolean | null | undefined

// One searchable attribute of an entity `T`. A list of these is the whole contract an entity has
// to provide: parsing, highlighting, validation, suggestions and matching all derive from it.
export type QueryField<T> = {
  // What the user types before the colon.
  readonly key: string
  readonly label: string
  readonly type: QueryFieldType
  readonly read: (record: T) => QueryFieldValue
  readonly options?: readonly string[]
  // Searched when a bare word is typed without a `field:` prefix.
  readonly freeText?: boolean
}

export function findQueryField<T>(
  fields: readonly QueryField<T>[],
  key: string,
): QueryField<T> | undefined {
  const needle = key.toLowerCase()

  return fields.find((field) => field.key.toLowerCase() === needle)
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, column) => column)

  for (let row = 1; row <= a.length; row += 1) {
    const current = [row]

    for (let column = 1; column <= b.length; column += 1) {
      const substitution = a.charAt(row - 1) === b.charAt(column - 1) ? 0 : 1

      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + substitution,
      )
    }

    previous = current
  }

  return previous[b.length] ?? 0
}

export function closestFieldKey<T>(
  fields: readonly QueryField<T>[],
  key: string,
): string | undefined {
  const needle = key.toLowerCase()
  let best: { readonly key: string; readonly distance: number } | undefined

  for (const field of fields) {
    const distance = field.key.startsWith(needle) ? 0 : editDistance(needle, field.key)

    if (distance <= 2 && (!best || distance < best.distance)) {
      best = { key: field.key, distance }
    }
  }

  return best?.key
}

const RELATIVE_DAY = /^today(?:([+-])(\d{1,4}))?$/i

const DOTTED_DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/

// Accepts the storage format (yyyy-MM-dd), the display format (DD.MM.YYYY), and `today`,
// optionally offset in days (`today+7`). Always answers in yyyy-MM-dd so values compare as strings.
export function resolveDateValue(raw: string, today: string): string | undefined {
  const relative = RELATIVE_DAY.exec(raw)

  if (relative) {
    const days = Number(relative[2] ?? 0) * (relative[1] === '-' ? -1 : 1)

    return Temporal.PlainDate.from(today).add({ days }).toString()
  }

  const dotted = DOTTED_DATE.exec(raw)

  return parseIsoDate(dotted ? `${dotted[3]}-${dotted[2]}-${dotted[1]}` : raw)?.toString()
}

export function isNumberValue(raw: string): boolean {
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(raw) && Number.isFinite(Number(raw))
}

export type ValueCheck = {
  readonly role: TokenRole
  readonly message?: string
  readonly severity?: DiagnosticSeverity
}

export function validateValue<T>(
  field: QueryField<T> | undefined,
  raw: string,
  today: string,
): ValueCheck {
  if (!field) return { role: 'free-text' }

  switch (field.type) {
    case 'number':
      return isNumberValue(raw)
        ? { role: 'value-number' }
        : {
            role: 'value-invalid',
            severity: 'error',
            message: `${field.key} expects a number, for example 120`,
          }
    case 'date':
      return resolveDateValue(raw, today)
        ? { role: 'value-date' }
        : {
            role: 'value-invalid',
            severity: 'error',
            message: `${field.key} expects a date such as 2026-10-04, 04.10.2026 or today+7`,
          }
    case 'boolean':
      return /^(?:true|false)$/i.test(raw)
        ? { role: 'value-boolean' }
        : {
            role: 'value-invalid',
            severity: 'error',
            message: `${field.key} expects true or false`,
          }
    case 'enum': {
      const known = field.options ?? []

      if (raw.includes('*') || known.some((option) => option.toLowerCase() === raw.toLowerCase())) {
        return { role: 'value-enum' }
      }

      // A warning, not an error: the backend may send a code this list has not caught up with.
      return {
        role: 'value-enum',
        severity: 'warning',
        message: `"${raw}" is not a known ${field.label.toLowerCase()}. Known: ${known.join(', ')}`,
      }
    }

    default:
      return { role: 'value-text' }
  }
}
