import { QueryValueError } from './errors'

/** Banded optimal-string-alignment distance: adjacent transpositions cost one edit. */
export function compileFuzzy(raw: string, distance = 2): (term: string) => boolean {
  if (
    !Number.isFinite(distance) ||
    distance < 0 ||
    distance > 2 ||
    (distance >= 1 && !Number.isInteger(distance))
  ) {
    throw new QueryValueError({
      message: 'Fuzzy distance must be a similarity below one or an integer from zero to two',
    })
  }

  const query = Array.from(raw)

  const limit =
    distance > 0 && distance < 1 ? Math.min(2, Math.floor((1 - distance) * query.length)) : distance

  if (limit === 0) return (term) => term === raw

  const infinity = limit + 1

  const rows = [
    new Uint32Array(query.length + 1),
    new Uint32Array(query.length + 1),
    new Uint32Array(query.length + 1),
  ] as const

  return (term) => {
    let [before, previous, current] = rows
    before.fill(infinity)
    previous.fill(infinity)
    current.fill(infinity)

    for (let column = 0; column <= Math.min(limit, query.length); column += 1)
      previous[column] = column
    let row = 0
    let preceding: string | undefined

    for (const character of term) {
      row += 1

      if (row > query.length + limit) return false
      const start = Math.max(1, row - limit)
      const end = Math.min(query.length, row + limit)
      current[0] = row <= limit ? row : infinity

      if (start > 1) current[start - 1] = infinity

      if (end < query.length) current[end + 1] = infinity
      let minimum = current[0] ?? infinity

      for (let column = start; column <= end; column += 1) {
        let edits = Math.min(
          (previous[column] ?? infinity) + 1,
          (current[column - 1] ?? infinity) + 1,
          (previous[column - 1] ?? infinity) + (character === query[column - 1] ? 0 : 1),
        )

        if (
          row > 1 &&
          column > 1 &&
          character === query[column - 2] &&
          preceding === query[column - 1]
        ) {
          edits = Math.min(edits, (before[column - 2] ?? infinity) + 1)
        }

        current[column] = edits
        minimum = Math.min(minimum, edits)
      }

      if (minimum > limit) return false
      preceding = character
      const reusable = before
      before = previous
      previous = current
      current = reusable
    }

    const edits = previous[query.length] ?? infinity

    return edits <= limit && (edits === 0 || edits < Math.min(row, query.length))
  }
}
