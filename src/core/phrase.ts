import { QueryValueError } from './errors'

/**
 * Equal words can be assigned in order: crossing two assignments cannot reduce their L1 cost.
 * Dynamic programming chooses a subset of stored positions, without enumerating permutations.
 */
function assignmentCost(
  query: readonly number[],
  stored: readonly number[],
  translation: number,
): number {
  const costs = new Float64Array(query.length + 1).fill(Infinity)
  costs[0] = 0

  for (let position = 0; position < stored.length; position += 1) {
    for (let count = Math.min(query.length, position + 1); count > 0; count -= 1) {
      const distance = Math.abs((stored[position] ?? 0) - (query[count - 1] ?? 0) - translation)
      costs[count] = Math.min(costs[count] ?? Infinity, (costs[count - 1] ?? Infinity) + distance)
    }
  }

  return costs[query.length] ?? Infinity
}

/** Phrase movement is the sum of positional shifts after choosing the best common translation. */
export function compilePhrase(
  query: readonly string[],
  proximity = 0,
): (tokens: readonly string[]) => boolean {
  if (!Number.isSafeInteger(proximity) || proximity < 0)
    throw new QueryValueError({
      message: 'Phrase proximity must be a nonnegative safe integer',
    })

  if (query.length === 0) return () => false
  const first = query[0]

  if (first === undefined) return () => false

  if (query.length === 1) return (tokens) => tokens.includes(first)

  if (proximity === 0) {
    return (tokens) => {
      for (
        let start = tokens.indexOf(first);
        start >= 0;
        start = tokens.indexOf(first, start + 1)
      ) {
        if (start + query.length > tokens.length) return false
        let offset = 1

        while (offset < query.length && tokens[start + offset] === query[offset]) offset += 1

        if (offset === query.length) return true
      }

      return false
    }
  }

  const required = new Map<string, number[]>()

  query.forEach((word, index) => {
    const positions = required.get(word) ?? []
    positions.push(index)
    required.set(word, positions)
  })

  return (tokens) => {
    if (tokens.length < query.length) return false

    const indexed = new Map<string, number[]>()

    tokens.forEach((word, index) => {
      if (!required.has(word)) return
      const positions = indexed.get(word) ?? []
      positions.push(index)
      indexed.set(word, positions)
    })

    for (const [word, positions] of required) {
      if ((indexed.get(word)?.length ?? 0) < positions.length) return false
    }

    // An optimum translation is a median of assigned (stored position - query position) deltas.
    // Trying that finite set, with an ordered assignment per word, is polynomial rather than
    // factorial even when the query contains many copies of the same word.
    const translations = new Set<number>()

    for (const [word, positions] of required) {
      for (const position of indexed.get(word) ?? []) {
        for (const offset of positions) translations.add(position - offset)
      }
    }

    for (const translation of translations) {
      let cost = 0

      for (const [word, positions] of required) {
        cost += assignmentCost(positions, indexed.get(word) ?? [], translation)

        if (cost > proximity) break
      }

      if (cost <= proximity) return true
    }

    return false
  }
}
