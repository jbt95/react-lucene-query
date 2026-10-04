import type { QueryField } from '../src/core'

export interface Shipment {
  readonly id: string
  readonly carrier: string
  readonly status: string
  readonly units: number
  readonly due: string
  readonly active: boolean
}

export const fields: readonly QueryField<Shipment>[] = [
  { key: 'id', label: 'Shipment', type: 'text', read: (record) => record.id, freeText: true },
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
    type: 'enum',
    options: ['ready', 'delayed', 'delivered'],
    read: (record) => record.status,
  },
  { key: 'units', label: 'Units', type: 'number', read: (record) => record.units },
  { key: 'due', label: 'Due', type: 'date', read: (record) => record.due },
  { key: 'active', label: 'Active', type: 'boolean', read: (record) => record.active },
]

export const records: readonly Shipment[] = [
  {
    id: 'SHP-1042',
    carrier: 'North Star',
    status: 'ready',
    units: 120,
    due: '2026-10-24',
    active: true,
  },
  { id: 'SHP-1043', carrier: 'Arc', status: 'delayed', units: 35, due: '2026-10-25', active: true },
  {
    id: 'SHP-1044',
    carrier: 'North Star',
    status: 'delivered',
    units: 450,
    due: '2026-10-23',
    active: false,
  },
  { id: 'SHP-1045', carrier: 'Atlas', status: 'ready', units: 75, due: '2026-10-28', active: true },
]
