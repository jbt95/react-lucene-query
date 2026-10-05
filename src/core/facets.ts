import { scalarText } from './evaluate'
import { fieldValues, type QueryField } from './fields'

/** Document frequency per field key, computed over the records the query already selects. */
export type FacetCounts = ReadonlyMap<string, ReadonlyMap<string, number>>

export type FacetOptions = {
  /** Restrict the work to these field keys; every configured field is counted otherwise. */
  readonly keys?: readonly string[]
  /** Count each record once per distinct value instead of once per value entry. */
  readonly distinct?: boolean
}

/**
 * Counts the values each field holds among matching records, so a filter panel can show how many
 * rows each option would leave. Counting runs over the result set only, which is what a consumer
 * needs: options that would return nothing never appear.
 */
export function facetCounts<T>(
  test: (record: T) => boolean,
  fields: readonly QueryField<T>[],
  records: readonly T[],
  options: FacetOptions = {},
): FacetCounts {
  const selected =
    options.keys === undefined
      ? fields
      : fields.filter((field) => options.keys?.includes(field.key))

  const counts = new Map<string, Map<string, number>>()

  for (const field of selected) counts.set(field.key, new Map())

  for (const record of records) {
    if (!test(record)) continue

    for (const field of selected) {
      const counted = counts.get(field.key)

      if (!counted) continue

      const seen = new Set<string>()

      for (const value of fieldValues(field, record)) {
        const text = scalarText(value)

        if (text === undefined) continue

        if (options.distinct === true) {
          if (seen.has(text)) continue
          seen.add(text)
        }

        counted.set(text, (counted.get(text) ?? 0) + 1)
      }
    }
  }

  return counts
}
