import type { QueryField } from '../src/core'

export interface Shipment {
  readonly id: string
  readonly carrier: string
  readonly status: string
  readonly units: number
  readonly due: string
  readonly active: boolean
  /** A multi-valued field: every entry is indexed, matched, counted, and suggested. */
  readonly tags: readonly string[]
  /** A typed date field: partially written queries cover their whole window. */
  readonly eta: string
}

export const fields: readonly QueryField<Shipment>[] = [
  { key: 'id', label: 'Shipment', type: 'keyword', read: (record) => record.id, freeText: true },
  {
    key: 'carrier',
    label: 'Carrier',
    type: 'text',
    read: (record) => record.carrier,
    freeText: true,
  },
  {
    key: 'status',
    label: 'Status',
    type: 'keyword',
    options: ['ready', 'delayed', 'delivered'],
    read: (record) => record.status,
  },
  { key: 'units', label: 'Units', type: 'keyword', read: (record) => record.units },
  { key: 'due', label: 'Due', type: 'keyword', read: (record) => record.due },
  { key: 'active', label: 'Active', type: 'keyword', read: (record) => record.active },
  { key: 'tags', label: 'Tags', type: 'keyword', read: (record) => record.tags },
  { key: 'eta', label: 'Eta', type: 'date', read: (record) => record.eta },
]

export const records: readonly Shipment[] = [
  {
    id: 'SHP-1042',
    carrier: 'North Star',
    status: 'ready',
    units: 120,
    due: '2026-10-24',
    active: true,
    tags: ['priority', 'insured'],
    eta: '2026-10-24T09:30:00Z',
  },
  {
    id: 'SHP-1043',
    carrier: 'Arc',
    status: 'delayed',
    units: 35,
    due: '2026-10-25',
    active: true,
    tags: ['economy'],
    eta: '2026-10-30',
  },
  {
    id: 'SHP-1044',
    carrier: 'North Star',
    status: 'delivered',
    units: 450,
    due: '2026-10-23',
    active: false,
    tags: ['priority', 'bulk'],
    eta: '2026-11-02T14:00:00Z',
  },
  {
    id: 'SHP-1045',
    carrier: 'Atlas',
    status: 'ready',
    units: 75,
    due: '2026-10-28',
    active: true,
    tags: [],
    eta: '2026-10',
  },
]
