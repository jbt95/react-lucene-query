/** The one list of field types. Both the type and the Schema that validates it are derived from it. */
export const QUERY_FIELD_TYPES = ['text', 'keyword', 'number', 'date'] as const

export type QueryFieldType = (typeof QUERY_FIELD_TYPES)[number]

/** One indexed value of a field. Blank and missing values are unindexed, exactly like Lucene. */
export type QueryFieldScalar = string | number | boolean | null | undefined

/** What an accessor may return. An array indexes one value per entry, as a multi-valued field. */
export type QueryFieldValue = QueryFieldScalar | readonly QueryFieldScalar[]

type QueryFieldBase = {
  // What the user types before the colon.
  readonly key: string
  readonly label: string
  readonly type: QueryFieldType
  readonly options?: readonly string[]
  // Searched when a bare word is typed without a `field:` prefix.
  readonly freeText?: boolean
  // Replaces the default tokenizer for `text` fields, applied to stored values and query terms
  // alike. Use it for stemming, diacritic folding, unit normalization, or CJK segmentation.
  readonly analyze?: (value: string) => readonly string[]
}

/**
 * One searchable attribute of an entity `T`. A list of these is the whole contract an entity has
 * to provide: parsing, highlighting, suggestions, and matching all derive from it.
 *
 * Provide exactly one accessor. `read` accepts arbitrary logic; `path` names a plain property
 * path, which additionally survives structured cloning into a worker.
 */
export type QueryField<T> =
  | (QueryFieldBase & {
      readonly read: (record: T) => QueryFieldValue
      readonly path?: undefined
    })
  | (QueryFieldBase & {
      readonly path: string
      readonly read?: undefined
    })

export function findQueryField<T>(
  fields: readonly QueryField<T>[],
  key: string,
): QueryField<T> | undefined {
  return fields.find((field) => field.key === key)
}

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Reads a dotted property path such as `meta.owner.name`. A missing, null, or unsafe segment is
 * unindexed rather than an error, and primitives simply have nothing to read.
 */
export function readPath<T>(record: T, path: string): QueryFieldScalar | undefined {
  let current: unknown = record

  for (const segment of path.split('.')) {
    if (current == null || UNSAFE_PATH_SEGMENTS.has(segment)) return undefined
    // SAFETY: the segment cannot reach Object.prototype, and indexing a primitive boxes it and
    // yields undefined, so this read never escapes the record's own data.
    const holder = current as Record<string, QueryFieldScalar>
    current = holder[segment]
  }

  // SAFETY: a path field holds plain data, and every branch above either returned early or read
  // one declared property, so what remains is a single indexable scalar.
  return current as QueryFieldScalar
}

function isValueList(value: QueryFieldValue): value is readonly QueryFieldScalar[] {
  return Array.isArray(value)
}

/** Every indexable value one field yields for a record, flattening a multi-valued field. */
export function fieldValues<T>(field: QueryField<T>, record: T): readonly QueryFieldScalar[] {
  const value = field.read === undefined ? readPath(record, field.path) : field.read(record)

  return isValueList(value) ? value : [value]
}

/** A field accessor is serializable only when it is a plain property path. */
export function isPathField<T>(field: QueryField<T>): boolean {
  return field.read === undefined
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

/** The nearest configured key within two edits, so a mistyped field can still be corrected. */
export function closestFieldKey<T>(
  fields: readonly QueryField<T>[],
  key: string,
): string | undefined {
  const needle = key
  let best: { readonly key: string; readonly distance: number } | undefined

  for (const field of fields) {
    const distance = field.key.startsWith(needle) ? 0 : editDistance(needle, field.key)

    if (distance <= 2 && (!best || distance < best.distance)) {
      best = { key: field.key, distance }
    }
  }

  return best?.key
}
