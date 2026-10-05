import { Result, Schema } from 'effect'
import { QueryTranslationError } from './core/errors'
import type { QueryField } from './core/fields'
import { hasErrors, parseQuery, type ParseOptions } from './core/parser'
import { stringifyQuery } from './core/stringify'
import type { ParsedQuery, QueryNode, QueryValue } from './core/types'

export { QueryTranslationError } from './core/errors'

/** JSON has no undefined: unqualified fields and open range bounds are explicitly null. */
export type JsonQueryValue =
  | Exclude<QueryValue, { readonly kind: 'range' }>
  | {
      readonly kind: 'range'
      readonly from: string | null
      readonly to: string | null
      readonly includeLower: boolean
      readonly includeUpper: boolean
    }

export type JsonQueryNode =
  | {
      readonly type: 'term'
      readonly field: string | null
      readonly value: JsonQueryValue
      readonly boost?: number
    }
  | {
      readonly type: 'boolean'
      readonly clauses: readonly {
        readonly occur: 'must' | 'should' | 'must-not'
        readonly node: JsonQueryNode
      }[]
      readonly boost?: number
    }

const JsonValueSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('term'), raw: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('phrase'),
    raw: Schema.String,
    proximity: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({ kind: Schema.Literal('wildcard'), raw: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('fuzzy'),
    raw: Schema.String,
    distance: Schema.optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 2 }))),
  }),
  Schema.Struct({ kind: Schema.Literal('regex'), raw: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('range'),
    from: Schema.NullOr(Schema.String),
    to: Schema.NullOr(Schema.String),
    includeLower: Schema.Boolean,
    includeUpper: Schema.Boolean,
  }),
])

const JsonNodeSchema: Schema.Codec<JsonQueryNode> = Schema.suspend(() =>
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal('term'),
      field: Schema.NullOr(Schema.String),
      value: JsonValueSchema,
      boost: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
    }),
    Schema.Struct({
      type: Schema.Literal('boolean'),
      clauses: Schema.Array(
        Schema.Struct({
          occur: Schema.Literals(['must', 'should', 'must-not']),
          node: JsonNodeSchema,
        }),
      ),
      boost: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
    }),
  ]),
)

/** Stable wire contract, deliberately independent of editor tokens and record accessors. */
export const QueryDocument = Schema.Struct({
  version: Schema.Literal(1),
  node: Schema.NullOr(JsonNodeSchema),
})

export type QueryDocument = typeof QueryDocument.Type

const decodeDocument = Schema.decodeUnknownResult(QueryDocument, { onExcessProperty: 'error' })

const equivalentDocument = Schema.toEquivalence(QueryDocument)

/** Bound traversal before a recursive Schema or serializer sees untrusted input, including cycles. */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- This bounded IO preflight must inspect unknown JSON before recursive Schema decoding. */
function checkBudget(input: unknown): Result.Result<void, QueryTranslationError> {
  const pending = [{ value: input, depth: 0 }]
  let values = 0
  let characters = 0

  while (pending.length > 0) {
    const entry = pending.pop()

    if (!entry) break
    values += 1

    if (typeof entry.value === 'string') characters += entry.value.length

    if (values > 32768 || characters > 131072 || entry.depth > 400) {
      return Result.fail(
        new QueryTranslationError({
          target: 'json',
          code: 'query-limit',
          message: 'Query JSON exceeds its value, text, or depth budget',
        }),
      )
    }

    if (entry.value !== null && typeof entry.value === 'object') {
      const arrayLength = Array.isArray(entry.value) ? entry.value.length : undefined
      const prototype = Object.getPrototypeOf(entry.value)

      const plain =
        arrayLength === undefined
          ? prototype === null || prototype === Object.prototype
          : prototype === Array.prototype

      if (!plain) {
        return Result.fail(
          new QueryTranslationError({
            target: 'json',
            code: 'invalid-json',
            message: 'Query JSON containers must be plain objects or arrays',
          }),
        )
      }

      const keys = Reflect.ownKeys(entry.value)

      if (
        keys.length + pending.length > 32768 ||
        (arrayLength !== undefined && arrayLength > 32768)
      ) {
        return Result.fail(
          new QueryTranslationError({
            target: 'json',
            code: 'query-limit',
            message: 'Query JSON exceeds its value budget',
          }),
        )
      }

      for (const key of keys) {
        if (arrayLength !== undefined && key === 'length') continue
        const property = Object.getOwnPropertyDescriptor(entry.value, key)

        if (typeof key !== 'string' || !property?.enumerable || !Object.hasOwn(property, 'value')) {
          return Result.fail(
            new QueryTranslationError({
              target: 'json',
              code: 'invalid-json',
              message: 'Query JSON properties must be own enumerable data properties',
            }),
          )
        }

        characters += key.length
        pending.push({ value: property.value, depth: entry.depth + 1 })
      }
    }
  }

  return Result.succeed(undefined)
}

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

function jsonNode(node: QueryNode): JsonQueryNode {
  if (node.type === 'boolean') {
    return {
      ...node,
      clauses: node.clauses.map((clause) => ({ ...clause, node: jsonNode(clause.node) })),
    }
  }

  const value =
    node.value.kind === 'range'
      ? { ...node.value, from: node.value.from ?? null, to: node.value.to ?? null }
      : node.value

  return { ...node, field: node.field ?? null, value }
}

function queryNode(node: JsonQueryNode): QueryNode {
  if (node.type === 'boolean') {
    return {
      ...node,
      clauses: node.clauses.map((clause) => ({ ...clause, node: queryNode(clause.node) })),
    }
  }

  const value =
    node.value.kind === 'range'
      ? { ...node.value, from: node.value.from ?? undefined, to: node.value.to ?? undefined }
      : node.value

  return { ...node, field: node.field ?? undefined, value }
}

/** Export an editor parse only after it is valid. An empty query is represented by node: null. */
export function toQueryJson(
  parsed: ParsedQuery,
): Result.Result<QueryDocument, QueryTranslationError> {
  if (hasErrors(parsed)) {
    return Result.fail(
      new QueryTranslationError({
        target: 'json',
        code: 'invalid-query',
        message: parsed.diagnostics
          .filter((entry) => entry.severity === 'error')
          .map((entry) => entry.message)
          .join('; '),
      }),
    )
  }

  return Result.gen(function* () {
    yield* checkBudget(parsed.node)

    const document = yield* Result.mapError(
      decodeDocument({
        version: 1,
        node: parsed.node === undefined ? null : jsonNode(parsed.node),
      }),
      (error) =>
        new QueryTranslationError({ target: 'json', code: 'invalid-json', message: error.message }),
    )

    yield* checkBudget(document)
    yield* parseDocument(document, [], { unknownFields: 'ignore' })

    return document
  })
}

function parseDocument<T>(
  document: QueryDocument,
  fields: readonly QueryField<T>[],
  options: ParseOptions,
): Result.Result<ParsedQuery, QueryTranslationError> {
  return Result.gen(function* () {
    const text = yield* Result.mapError(
      Result.try(() => {
        const node = document.node === null ? undefined : queryNode(document.node)
        const rendered = stringifyQuery(node)

        // Multi-clause and prefixed roots need no outer group. Single optional terms and
        // boosted roots retain grouping so their Boolean node kind and boost scope survive.
        return node?.type === 'boolean' &&
          node.boost === undefined &&
          (node.clauses.length > 1 || node.clauses.some((clause) => clause.occur !== 'should'))
          ? rendered.slice(1, -1)
          : rendered
      }),
      (error) =>
        new QueryTranslationError({
          target: 'json',
          code: 'invalid-json',
          message: error instanceof Error ? error.message : 'Invalid query tree',
        }),
    )

    const parsed = parseQuery(text, fields, options)

    if (hasErrors(parsed)) {
      return yield* Result.fail(
        new QueryTranslationError({
          target: 'json',
          code: 'invalid-query',
          message: parsed.diagnostics
            .filter((entry) => entry.severity === 'error')
            .map((entry) => entry.message)
            .join('; '),
        }),
      )
    }

    const restored: QueryDocument = {
      version: 1,
      node: parsed.node === undefined ? null : jsonNode(parsed.node),
    }

    if (!equivalentDocument(document, restored)) {
      return yield* Result.fail(
        new QueryTranslationError({
          target: 'json',
          code: 'invalid-json',
          message:
            'Query JSON cannot be rendered without changing its node kinds or clause structure',
        }),
      )
    }

    return parsed
  })
}

/** Decode a wire document, then revalidate canonical text against the receiving application's fields. */
export function fromQueryJson<T>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public wire boundary: the bounded Schema decoder below establishes the contract.
  input: unknown,
  fields: readonly QueryField<T>[],
  options: ParseOptions = {},
): Result.Result<ParsedQuery, QueryTranslationError> {
  return Result.gen(function* () {
    yield* checkBudget(input)

    const document = yield* Result.mapError(
      decodeDocument(input),
      (error) =>
        new QueryTranslationError({ target: 'json', code: 'invalid-json', message: error.message }),
    )

    return yield* parseDocument(document, fields, options)
  })
}
