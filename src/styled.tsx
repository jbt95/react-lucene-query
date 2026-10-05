// scripts/build.ts emits the published 'use client' boundary.

import { useId } from 'react'
import { Query, type QueryRootProps } from './input'
import { useQueryContext } from './context'

export interface QuerySearchFieldProps<T> extends Omit<QueryRootProps<T>, 'children'> {
  readonly label: string
  readonly placeholder?: string
  readonly className?: string
  readonly disabled?: boolean
  readonly summary?: string
}

function Field({
  label,
  placeholder,
  disabled,
  summary,
}: Pick<QuerySearchFieldProps<never>, 'label' | 'placeholder' | 'disabled' | 'summary'>) {
  const editor = useQueryContext()
  const summaryId = useId()

  return (
    <fieldset
      className="rlq:relative rlq:m-0 rlq:min-w-0 rlq:border-0 rlq:p-0 rlq:disabled:opacity-60"
      disabled={disabled}
    >
      <label className="rlq:mb-2 rlq:block rlq:text-sm rlq:font-medium" htmlFor={editor.inputId}>
        {label}
      </label>
      <div className="rlq:flex rlq:items-start rlq:gap-2">
        <div className="rlq:relative rlq:grid rlq:min-w-0 rlq:flex-1 rlq:rounded-md rlq:border rlq:border-(--rlq-border) rlq:bg-(--rlq-surface) rlq:focus-within:outline-2 rlq:focus-within:outline-offset-2 rlq:focus-within:outline-(--rlq-accent)">
          <Query.Highlight
            placeholder={placeholder}
            className="rlq-highlight rlq-text-layer rlq:pointer-events-none"
          />
          <Query.Input
            aria-describedby={summary ? summaryId : undefined}
            className="rlq-text-layer rlq:h-full rlq:w-full rlq:resize-none rlq:overflow-hidden rlq:bg-transparent rlq:text-transparent rlq:caret-(--rlq-text) rlq:outline-none"
          />
        </div>
        <Query.Submit className="rlq-button rlq:bg-(--rlq-accent) rlq:text-(--rlq-on-accent)" />
        <Query.Clear
          className="rlq-button rlq:bg-(--rlq-muted)"
          disabled={!editor.value || disabled}
        />
      </div>
      <Query.Suggestions className="rlq-list rlq:mt-2 rlq:max-h-64 rlq:overflow-auto rlq:rounded-md rlq:bg-(--rlq-surface) rlq:p-1 rlq:shadow-lg">
        {(items) =>
          items.map((item, index) => (
            <Query.Option
              key={item.id}
              item={item}
              index={index}
              className="rlq:flex rlq:min-h-11 rlq:cursor-pointer rlq:items-center rlq:gap-3 rlq:rounded-sm rlq:px-3 rlq:py-2 rlq:data-active:bg-(--rlq-muted)"
            >
              <span className="rlq:font-mono rlq:text-sm">{item.label}</span>
              <span className="rlq:min-w-0 rlq:flex-1 rlq:truncate rlq:text-xs rlq:text-(--rlq-secondary)">
                {item.detail}
              </span>
              <span className="rlq:text-xs rlq:text-(--rlq-secondary) rlq:tabular-nums">
                {item.count ?? item.tag}
              </span>
            </Query.Option>
          ))
        }
      </Query.Suggestions>
      <Query.Diagnostics className="rlq-list rlq:mt-2 rlq:text-sm rlq:text-(--rlq-error)" />
      {summary ? (
        <output
          id={summaryId}
          className="rlq:mt-2 rlq:block rlq:text-sm rlq:text-(--rlq-secondary)"
        >
          {summary}
        </output>
      ) : null}
    </fieldset>
  )
}

/** Optional Tailwind presentation over the same public primitives consumers can compose themselves. */
export function QuerySearchField<T>({
  label,
  placeholder = 'field:value AND …',
  className,
  disabled,
  summary,
  ...root
}: QuerySearchFieldProps<T>) {
  return (
    <div className={['rlq-field', className].filter(Boolean).join(' ')}>
      <Query.Root {...root}>
        <Field label={label} placeholder={placeholder} disabled={disabled} summary={summary} />
      </Query.Root>
    </div>
  )
}
