import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import initSqlJs from 'sql.js/dist/sql-asm.js'
import type { Connect } from 'vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { WBS_DDL } from './src/lib/wbsSchemaSql'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WBS_DATA_DIR = path.join(__dirname, '.wbs-data')
const WBS_DB_FILE = path.join(WBS_DATA_DIR, 'wbs.db')
const WBS_DB_ROUTE = '/__wbs_sqlite/db'

function wbsSqliteFileMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = (req.url ?? '').split('?')[0]
    if (url !== WBS_DB_ROUTE) {
      next()
      return
    }

    if (req.method === 'GET') {
      try {
        if (!fs.existsSync(WBS_DB_FILE)) {
          res.statusCode = 404
          res.end()
          return
        }
        const buf = fs.readFileSync(WBS_DB_FILE)
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-store')
        res.end(buf)
      } catch (e) {
        res.statusCode = 500
        res.end(e instanceof Error ? e.message : 'read failed')
      }
      return
    }

    if (req.method === 'PUT') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try {
          fs.mkdirSync(WBS_DATA_DIR, { recursive: true })
          fs.writeFileSync(WBS_DB_FILE, Buffer.concat(chunks))
          res.statusCode = 204
          res.end()
        } catch (e) {
          res.statusCode = 500
          res.end(e instanceof Error ? e.message : 'write failed')
        }
      })
      req.on('error', () => {
        res.statusCode = 500
        res.end('request error')
      })
      return
    }

    res.statusCode = 405
    res.end()
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'wbs-sqlite-repo-file',
      async buildStart() {
        fs.mkdirSync(WBS_DATA_DIR, { recursive: true })
        const needSeed =
          !fs.existsSync(WBS_DB_FILE) || (fs.existsSync(WBS_DB_FILE) && fs.statSync(WBS_DB_FILE).size === 0)
        if (needSeed) {
          const SQL = await initSqlJs()
          const db = new SQL.Database()
          db.exec(WBS_DDL)
          fs.writeFileSync(WBS_DB_FILE, Buffer.from(db.export()))
          db.close()
        } else {
          try {
            const SQL = await initSqlJs()
            const buf = fs.readFileSync(WBS_DB_FILE)
            const db = new SQL.Database(buf)
            const tbl = db.exec("SELECT name FROM sqlite_master WHERE type='table'")
            const names = new Set(tbl[0]?.values?.map((r) => String(r[0])) ?? [])
            if (!names.has('projects')) {
              db.exec(WBS_DDL)
              fs.writeFileSync(WBS_DB_FILE, Buffer.from(db.export()))
            }
            db.close()
          } catch {
            /* ignore */
          }
        }
      },
      configureServer(server) {
        fs.mkdirSync(WBS_DATA_DIR, { recursive: true })
        server.middlewares.use(wbsSqliteFileMiddleware())
      },
      configurePreviewServer(server) {
        fs.mkdirSync(WBS_DATA_DIR, { recursive: true })
        server.middlewares.use(wbsSqliteFileMiddleware())
      },
    },
  ],
})
