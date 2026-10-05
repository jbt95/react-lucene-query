import { lazy, StrictMode, Suspense, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createQueryEngine, Query, useQuerySearch } from '../src'
import { QuerySearchField } from '../src/styled'
import { fields, records } from '../tests/fixtures'
import '../src/styles.css'
import './style.css'

const QueryCodeMirror = lazy(() =>
  import('../src/codemirror').then((module) => ({ default: module.QueryCodeMirror })),
)

const engine = createQueryEngine({ fields })

const presets = [
  'status:ready AND units:[100 TO 200]',
  'carrier:"North Star"',
  'due:[2026-10-24 TO 2026-10-25]',
  'tags:priority AND eta:[2026-11 TO *]',
  '*:* AND NOT status:delivered',
  'carrier:/n.*h/ OR carrier:atlas~1',
]

function App() {
  const [mode, setMode] = useState<'styled' | 'headless' | 'codemirror'>('styled')
  const search = useQuerySearch({ engine, records })

  const root = {
    engine,
    records,
    value: search.draft,
    parsed: search.parsedDraft,
    onValueChange: search.setDraft,
    onSubmit: search.submit,
  }

  return (
    <main className="playground">
      <header className="masthead">
        <a href="https://github.com/jbt95/react-lucene-query" className="wordmark">
          react-lucene-query <span> / playground</span>
        </a>
        <span className="version">0.1.0</span>
      </header>
      <div className="intro">
        <p className="eyebrow">A language for finding things</p>
        <h1>
          Less clicking.
          <br />
          More precise queries.
        </h1>
        <p className="lede">
          Compose a search experience around your data. Same schema, same language — your interface.
        </p>
      </div>
      <section className="workbench" aria-labelledby="workbench-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">01 / Compose</p>
            <h2 id="workbench-title">Shipment explorer</h2>
          </div>
          <fieldset className="modes" aria-label="Editor presentation">
            {(['styled', 'headless', 'codemirror'] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={mode === item}
                onClick={() => setMode(item)}
              >
                {{ styled: 'Styled field', headless: 'Headless', codemirror: 'CodeMirror' }[item]}
              </button>
            ))}
          </fieldset>
        </div>
        {mode === 'styled' ? (
          <QuerySearchField
            {...root}
            label="Query"
            placeholder="Try status:ready AND units:[100 TO 200]"
            summary={
              search.isPending
                ? 'Draft — press Enter or Search to apply.'
                : 'Applied query. Edit to refine your search.'
            }
          />
        ) : (
          <Query.Root {...root}>
            {mode === 'codemirror' ? (
              <Suspense fallback={<p>Loading editor…</p>}>
                <QueryCodeMirror
                  label="Query"
                  placeholder="Try status:ready"
                  className="code-editor rlq-field rlq-highlight"
                />
              </Suspense>
            ) : (
              <>
                <label htmlFor="headless-input">Your own input, no library styles</label>
                <Query.Input id="headless-input" className="custom-input" />
              </>
            )}
            <div className="custom-actions">
              <Query.Submit />
              <Query.Clear />
            </div>
            {mode === 'headless' ? <Query.Suggestions className="custom-suggestions" /> : null}
            <Query.Chips className="applied-chips" />
            <Query.Facets field="status" className="applied-facets" />
            <Query.Diagnostics className="custom-diagnostics" />
          </Query.Root>
        )}
        <div className="presets">
          <span>Try a query</span>
          {presets.map((preset) => (
            <button type="button" key={preset} onClick={() => search.apply(preset)}>
              <code>{preset}</code>
            </button>
          ))}
        </div>
      </section>
      <section className="results" aria-labelledby="results-title">
        <div className="results-heading">
          <h2 id="results-title">Matching shipments</h2>
          <output className="result-count">
            {search.matches.length} of {records.length}
          </output>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Shipment</th>
                <th scope="col">Carrier</th>
                <th scope="col">Status</th>
                <th scope="col" className="numeric">
                  Units
                </th>
                <th scope="col">Due date</th>
              </tr>
            </thead>
            <tbody>
              {search.matches.map((record) => (
                <tr key={record.id}>
                  <th scope="row">
                    <code>{record.id}</code>
                  </th>
                  <td>{record.carrier}</td>
                  <td>
                    <span className="status" data-status={record.status}>
                      {record.status}
                    </span>
                  </td>
                  <td className="numeric">{record.units}</td>
                  <td>
                    <time dateTime={record.due}>{record.due}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!search.matches.length ? (
          <p className="empty">
            No shipments match this query. Try a broader condition or clear the field.
          </p>
        ) : null}
        <p className="applied">
          Applied <code>{search.applied || '(all shipments)'}</code>
        </p>
      </section>
      <aside className="syntax" aria-labelledby="syntax-title">
        <div>
          <p className="eyebrow">02 / Learn</p>
          <h2 id="syntax-title">Lucene syntax. Useful combinations.</h2>
        </div>
        <dl>
          <div>
            <dt>
              <code>field:value</code>
            </dt>
            <dd>Search analyzed text or exact keyword values.</dd>
          </div>
          <div>
            <dt>
              <code>AND · OR · NOT</code>
            </dt>
            <dd>Use OR between adjacent terms. Group with parentheses.</dd>
          </div>
          <div>
            <dt>
              <code>[a TO b] · {'{a TO b}'}</code>
            </dt>
            <dd>Select an inclusive or exclusive lexical range.</dd>
          </div>
          <div>
            <dt>
              <code>term* · term~1 · /pattern/ · ^2</code>
            </dt>
            <dd>Use wildcards, fuzzy terms, regular expressions, or boosts.</dd>
          </div>
        </dl>
      </aside>
      <footer>
        <span>Headless primitives · Effect core · Optional Tailwind & CodeMirror</span>
        <a href="https://github.com/jbt95/react-lucene-query">Source & documentation ↗</a>
      </footer>
    </main>
  )
}

const container = document.getElementById('root')

if (!container) throw new Error('Missing example root')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
