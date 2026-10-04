import { Temporal } from '@js-temporal/polyfill'

export function parseIsoDate(value: string): Temporal.PlainDate | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined

  try {
    return Temporal.PlainDate.from(value, { overflow: 'reject' })
  } catch {
    return undefined
  }
}

export function currentDate(): string {
  return Temporal.Now.plainDateISO().toString()
}
