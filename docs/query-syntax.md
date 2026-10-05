# Query syntax

[← README](../README.md#appendix) · [Quick start](../README.md#quick-start)

This library implements the classic Lucene query language, verified against the grammar and conformance cases of [bripkens/lucene](https://github.com/bripkens/lucene). It does not reproduce Apache Lucene index execution, analyzers, or scoring.

| Syntax                                   | Meaning                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| `status:ready`                           | Exact value; `keyword` fields compare case-sensitively      |
| `carrier:"North Star"`                   | Phrase; escape quotes and backslashes with `\`              |
| `north`                                  | Analyzed term across `freeText` fields                      |
| `carrier:north*`, `carrier:n*rth`        | Wildcards over complete tokens; `?` matches one character   |
| `north\*`                                | An escaped wildcard is a literal character                  |
| `units:[20 TO 100]`                      | Inclusive range                                             |
| `units:{20 TO 100}`, `units:[20 TO 100}` | Exclusive and mixed bounds                                  |
| `units:[* TO 100]`, `units:[20 TO *]`    | Open bounds; a quoted `"*"` stays a literal bound           |
| `due:2026-10`, `due:[2026-10 TO *]`      | Date literals and ranges over a `date` field                |
| `carrier:/no.*th/`                       | Lucene regular expression, matched against complete tokens  |
| `north~`, `north~1`, `north~0.8`         | Fuzzy term: up to two edits, or a legacy similarity         |
| `"north star"~10`                        | Phrase proximity                                            |
| `a^2`, `(a b)^2`                         | Boost; it round-trips but local filtering does not rank     |
| `a AND b` / `a b`                        | Explicit / implicit conjunction                             |
| `a OR b`                                 | Disjunction                                                 |
| `+a`                                     | Required clause                                             |
| `NOT a` / `-a` / `!a`                    | Prohibited clause                                           |
| `a AND NOT b`                            | Conjunction with a prohibited clause                        |
| `(a OR b) AND c`                         | Grouping                                                    |
| `status:(ready OR delayed)`              | Field group; the field is inherited into every descendant   |
| `*:*`                                    | Match every record                                          |
| `foo\~bar:baz`                           | Any reserved character can be escaped, in fields and values |

Keywords are uppercase. `&&` and `||` are aliases for `AND` and `OR`. Non-reserved `<` and `>` are ordinary term characters, never comparisons.
Unknown fields are valid syntax and simply match no records; `unknownFields` decides whether the engine also warns about them.
Values are never validated against a type: `units:many` is a legal query that matches nothing, because `many` is not one of the field's indexed values.
A Boolean group with only prohibited clauses matches no records, exactly like Apache Lucene.

Not supported: scoring or ranking, stop words, and index execution. Stemming, diacritic folding, and CJK segmentation are available per field through `analyze`.

The parser rejects queries over **32,768 UTF-16 code units**, **4,096 tokens**, or **100 nested conditions**. Suggestions use the same text/token budgets. Public standalone tokenization is a low-level helper without these budgets.

`stringifyQuery(node)` exports canonical Lucene text from a parsed AST. It re-encodes occurrence, grouping, and escaping from the tree rather than returning the original source, so `parse → stringify → parse` preserves meaning but not whitespace.

Local analysis defaults to a fixed lowercase Unicode letter/digit tokenizer with consecutive positions. It is not `StandardAnalyzer`: there is no stemming, stop-word removal, or CJK segmentation unless a field supplies `analyze`.

Related: [Field types and analysis](fields.md) · [Safe query building](query-building.md)
