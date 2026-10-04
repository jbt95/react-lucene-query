// scripts/build.ts emits the published 'use client' boundary.

import { useEffect, useRef, type HTMLAttributes } from 'react'
import {
  acceptCompletion,
  autocompletion,
  completionStatus,
  startCompletion,
  type Completion,
} from '@codemirror/autocomplete'
import { history, historyKeymap } from '@codemirror/commands'
import { linter } from '@codemirror/lint'
import {
  Annotation,
  Compartment,
  EditorState,
  Prec,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  placeholder as placeholderExtension,
} from '@codemirror/view'
import { applySuggestion } from './core'
import { useQueryContext, type QueryContextValue } from './query-context'

const external = Annotation.define<boolean>()

export interface QueryCodeMirrorProps extends HTMLAttributes<HTMLDivElement> {
  readonly label: string
  readonly placeholder?: string
  readonly extensions?: readonly Extension[]
  readonly disabled?: boolean
}

const EMPTY_EXTENSIONS: readonly Extension[] = []

function decorations(editor: QueryContextValue, text: string) {
  const parsed = editor.parse(text)
  const ranges: Range<Decoration>[] = []

  for (const [index, token] of parsed.tokens.entries()) {
    const role = parsed.roles[index]

    if (role && token.end > token.start) {
      ranges.push(
        Decoration.mark({ attributes: { 'data-role': role } }).range(token.start, token.end),
      )
    }
  }

  return Decoration.set(ranges, true)
}

/** Optional CodeMirror adapter. Install its five optional peer packages before importing. */
export function QueryCodeMirror({
  label,
  placeholder = '',
  extensions = EMPTY_EXTENSIONS,
  disabled = false,
  ...props
}: QueryCodeMirrorProps) {
  const editor = useQueryContext()
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>()
  const latest = useRef(editor)
  const configuration = useRef(new Compartment())

  useEffect(() => {
    latest.current = editor
  }, [editor])

  useEffect(() => {
    if (!host.current) return

    const coloring = StateField.define({
      create: (state) => decorations(latest.current, state.doc.toString()),
      update: (previous, transaction) =>
        transaction.docChanged
          ? decorations(latest.current, transaction.newDoc.toString())
          : previous,
      provide: (field) => EditorView.decorations.from(field),
    })

    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          history(),
          keymap.of(historyKeymap),
          EditorView.lineWrapping,
          coloring,
          configuration.current.of([]),
          autocompletion({
            interactionDelay: 0,
            override: [
              (context) => {
                const text = context.state.doc.toString()
                const list = latest.current.getSuggestions(text, context.pos)

                if (!list) return null

                const options: Completion[] = list.items.map((item) => ({
                  label: item.label,
                  detail: item.detail,
                  type: item.kind,
                  apply: (target) => {
                    const next = applySuggestion(text, list, item)
                    target.dispatch({
                      changes: { from: list.from, to: list.to, insert: item.insert },
                      selection: { anchor: next.caret },
                    })

                    if (item.kind !== 'value' || item.keepOpen) startCompletion(target)
                  },
                }))

                return { from: list.from, to: list.to, options, filter: false }
              },
            ],
            defaultKeymap: true,
          }),
          Prec.highest(
            keymap.of([
              { key: 'Tab', run: acceptCompletion },
              {
                key: 'Enter',
                run: (target) => {
                  const list = latest.current.getSuggestions(
                    target.state.doc.toString(),
                    target.state.selection.main.head,
                  )

                  if (
                    completionStatus(target.state) === 'active' &&
                    list?.autoSelect &&
                    acceptCompletion(target)
                  )
                    return true
                  latest.current.onSubmit(target.state.doc.toString())

                  return true
                },
              },
            ]),
          ),
          linter(
            (target) =>
              latest.current.parse(target.state.doc.toString()).diagnostics.map((entry) => ({
                from: entry.start,
                to: entry.end,
                message: entry.message,
                severity: entry.severity,
              })),
            { delay: 150 },
          ),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) => transaction.annotation(external))
            ) {
              latest.current.onValueChange(update.state.doc.toString())
            }
          }),
          EditorView.theme({
            '&': { fontSize: '14px' },
            '.cm-content': {
              fontFamily: 'ui-monospace, monospace',
              minHeight: '44px',
              padding: '10px 12px',
            },
            '.cm-line': { padding: '0' },
          }),
        ],
      }),
    })

    view.current = instance

    return () => {
      instance.destroy()
      view.current = undefined
    }
  }, [])

  useEffect(() => {
    const instance = view.current

    if (!instance) return
    const current = instance.state.doc.toString()

    const effects = configuration.current.reconfigure([
      placeholderExtension(placeholder),
      EditorView.editable.of(!disabled),
      EditorState.readOnly.of(disabled),
      EditorView.contentAttributes.of({
        'aria-label': label,
        'aria-describedby': editor.diagnosticsId,
        'aria-invalid': String(editor.hasError),
      }),
      ...extensions,
    ])

    instance.dispatch({
      changes:
        current === editor.value
          ? undefined
          : { from: 0, to: current.length, insert: editor.value },
      effects,
      annotations: external.of(true),
    })
  }, [
    editor.value,
    editor.hasError,
    editor.diagnosticsId,
    editor.parse,
    label,
    placeholder,
    extensions,
    disabled,
  ])

  return <div {...props} ref={host} />
}
