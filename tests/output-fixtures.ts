import type { QueryField } from '../src/core'
import type { PostgresOptions } from '../src/postgres'

export interface OutputRecord {
  readonly id: number
  readonly status: string | null
  readonly units: number | null
  readonly due: string | null
}

export const outputFields: readonly QueryField<OutputRecord>[] = [
  { key: 'status', label: 'Status', type: 'keyword', path: 'status', freeText: true },
  { key: 'units', label: 'Units', type: 'number', path: 'units' },
  { key: 'due', label: 'Due', type: 'date', path: 'due' },
]

export const postgresOptions: PostgresOptions<OutputRecord> = {
  fields: outputFields,
  columns: {
    status: { column: 'status', type: 'text' },
    units: { column: 'units', type: 'number' },
    due: { column: 'due', type: 'timestamptz' },
  },
}

export const outputRecords: readonly OutputRecord[] = [
  { id: 1, status: 'ready', units: 100, due: '2026-10-01T00:00:00.000Z' },
  { id: 2, status: 'delayed', units: 200, due: '2026-10-24T12:00:00.000Z' },
  { id: 3, status: 'READY', units: 300, due: '2026-11-01T00:00:00.000Z' },
  { id: 4, status: null, units: null, due: null },
  { id: 5, status: 'ready', units: 0, due: '2026-10-31T23:59:59.999Z' },
  { id: 6, status: "x' OR TRUE --", units: -10, due: '2026-09-30T23:59:59.999Z' },
]

/** Shared real-database parity cases, including source-language behavior that differs from SQL. */
export const postgresParityQueries = [
  '',
  '*:*',
  'status:ready',
  'status:READY',
  'ready',
  'status:""',
  'status:"x\' OR TRUE --"',
  'unknown:ready',
  '*:* AND NOT unknown:ready',
  'units:100',
  'units:0x64',
  'units:many',
  'units:""',
  'units:[100 TO 200]',
  'units:{100 TO 200}',
  'units:[100 TO 200}',
  'units:{100 TO 200]',
  'units:[* TO 100]',
  'units:[100 TO *]',
  'units:[* TO *]',
  'units:[many TO 100]',
  'units:[300 TO 100]',
  'due:0001',
  'due:9999',
  'due:2026',
  'due:2026-10',
  'due:2026-10-24',
  'due:"2026-10-24T14:00+02:00"',
  'due:"2026-10-31T23:59:59.999Z"',
  'due:2026-02-30',
  'due:[2026-10 TO 2026-10]',
  'due:{2026-10-01 TO 2026-10-24}',
  'due:[* TO 2026-10-24]',
  'due:{2026-10 TO *]',
  'due:[* TO *]',
  'due:[wrong TO *]',
  'status:ready AND units:[0 TO 100]',
  'status:ready units:200',
  '+status:ready units:200',
  '+status:ready -units:0',
  'NOT status:ready',
  '-status:ready',
  '*:* AND NOT status:ready',
  '*:* AND NOT units:[100 TO 200]',
  '*:* AND NOT due:2026-10',
  '(status:ready OR status:delayed) AND units:[100 TO 200]',
  '*:* AND NOT (status:ready OR units:300)',
  '(+status:ready units:200) OR status:READY',
  'NOT status:ready AND NOT units:100',
  'status:ready AND units:100 OR status:READY',
] as const
