import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { Result } from 'effect'
import { createQueryEngine } from '../src/engine-adapter'
import { toPostgres } from '../src/postgres'
import {
  outputFields,
  outputRecords,
  postgresOptions,
  postgresParityQueries,
} from './output-fixtures'

// Opt-in only. Never discover application credentials or connect to a non-loopback database.
// Use a dedicated trust-authenticated test instance; all writes are session-local temporary data.
const configuredPort = process.env.QUERY_TEST_POSTGRES_PORT

test.skipIf(configuredPort === undefined)(
  'PostgreSQL and the local evaluator select identical records',
  async () => {
    const port = Number(configuredPort)

    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid test PostgreSQL port')

    const database = new SQL({
      hostname: '127.0.0.1',
      port,
      username: 'postgres',
      database: 'postgres',
      password: '',
      max: 1,
      connectionTimeout: 3,
    })

    const engine = createQueryEngine({ fields: outputFields })

    try {
      await database.begin(async (transaction) => {
        await transaction`
        CREATE TEMPORARY TABLE rlq_output_records (
          id integer PRIMARY KEY,
          status text,
          units double precision,
          due timestamptz(3)
        ) ON COMMIT DROP
      `

        for (const record of outputRecords) {
          await transaction`
          INSERT INTO pg_temp.rlq_output_records (id, status, units, due)
          VALUES (${record.id}, ${record.status}, ${record.units}, ${record.due})
        `
        }

        for (const text of postgresParityQueries) {
          const query = Result.getOrThrow(toPostgres(engine.parse(text), postgresOptions))

          const rows = await transaction.unsafe<{ id: number }[]>(
            `SELECT id FROM pg_temp.rlq_output_records WHERE ${query.sql} ORDER BY id`,
            [...query.params],
          )

          expect(rows.map((row) => row.id)).toEqual(
            engine.filter(text, outputRecords).map((record) => record.id),
          )
        }
      })
    } finally {
      await database.close()
    }
  },
  30000,
)
