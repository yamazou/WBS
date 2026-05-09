import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import initSqlJs from 'sql.js/dist/sql-asm.js'
import type { Connect } from 'vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { WBS_DDL } from './src/lib/wbsSchemaSql'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WBS_DATA_DIR = path.join(__dirname, '.wbs-data')
const WBS_DB_FILE = path.join(WBS_DATA_DIR, 'wbs.db')
const WBS_BACKUP_DIR = path.join(WBS_DATA_DIR, 'backups')
const WBS_BACKUP_LOG_FILE = path.join(WBS_DATA_DIR, 'backup.log')
const WBS_DB_ROUTE = '/__wbs_sqlite/db'
const WBS_BACKUPS_ROUTE = '/__wbs_sqlite/backups'
const WBS_RESTORE_ROUTE = '/__wbs_sqlite/restore'
const WBS_SNAPSHOT_ROUTE = '/__wbs_sqlite/snapshot'
const WBS_BACKUP_KEEP_GENERATIONS = 10
const WBS_BACKUP_MIN_INTERVAL_MS = 30 * 60 * 1000
let sqlModulePromise: ReturnType<typeof initSqlJs> | null = null

async function getSqlModule(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!sqlModulePromise) sqlModulePromise = initSqlJs()
  return sqlModulePromise
}


type WbsSnapshot = {
  selectedProjectName: string
  projects: Record<
    string,
    {
      tasks: Array<{
        id: number
        name: string
        parent_id: number | null
        order: number
        planned_start_date: string
        planned_end_date: string
        actual_start_date: string
        actual_end_date: string
        role: string
        status: string
        progress: number
        mh_md: string
      }>
      company: string
      po_date: string
      issues: unknown[]
      system_overview: unknown[]
      mom_documents: unknown[]
    }
  >
  zoom: 'day' | 'week' | 'month'
  ganttUnitScalePercent: number
}

function readSnapshotViaNativeSqlite(dbFilePath: string): WbsSnapshot {
  const db = new DatabaseSync(dbFilePath)
  try {
    db.exec(WBS_DDL)
    const projects: WbsSnapshot['projects'] = {}
    const names: string[] = []
    const projRows = db
      .prepare(
        'SELECT name, company, po_date, issues_json, system_overview_json, mom_json FROM projects ORDER BY sort_order ASC, name ASC',
      )
      .all() as Array<{
      name: string
      company: string
      po_date: string
      issues_json: string
      system_overview_json: string
      mom_json: string
    }>
    for (const p of projRows) {
      names.push(String(p.name ?? ''))
      const taskRows = db
        .prepare(
          `SELECT id, name, parent_id, task_order, planned_start_date, planned_end_date, actual_start_date, actual_end_date, role, status, progress, mh_md
           FROM tasks WHERE project_name = ? ORDER BY task_order ASC, id ASC`,
        )
        .all(p.name) as Array<Record<string, unknown>>
      const tasks = taskRows.map((t) => ({
        id: Number(t.id ?? 0),
        name: String(t.name ?? ''),
        parent_id: t.parent_id == null ? null : Number(t.parent_id),
        order: Number(t.task_order ?? 0),
        planned_start_date: String(t.planned_start_date ?? ''),
        planned_end_date: String(t.planned_end_date ?? ''),
        actual_start_date: String(t.actual_start_date ?? ''),
        actual_end_date: String(t.actual_end_date ?? ''),
        role: String(t.role ?? ''),
        status: String(t.status ?? 'Not Started'),
        progress: Number(t.progress ?? 0),
        mh_md: String(t.mh_md ?? ''),
      }))
      const issues = (() => {
        try {
          const x = JSON.parse(String(p.issues_json ?? '[]'))
          return Array.isArray(x) ? x : []
        } catch {
          return []
        }
      })()
      const systemOverview = (() => {
        try {
          const x = JSON.parse(String(p.system_overview_json ?? '[]'))
          return Array.isArray(x) ? x : []
        } catch {
          return []
        }
      })()
      const momDocuments = (() => {
        try {
          const x = JSON.parse(String(p.mom_json ?? '{}')) as { docs?: unknown[] }
          return Array.isArray(x.docs) ? x.docs : []
        } catch {
          return []
        }
      })()
      projects[p.name] = {
        tasks,
        company: String(p.company ?? ''),
        po_date: String(p.po_date ?? ''),
        issues,
        system_overview: systemOverview,
        mom_documents: momDocuments,
      }
    }
    const selected = (db.prepare("SELECT value FROM app_meta WHERE key = 'selected_project_name'").get() as { value?: string } | undefined)
      ?.value
    const zoomRaw = (db.prepare("SELECT value FROM app_meta WHERE key = 'zoom'").get() as { value?: string } | undefined)?.value
    const scaleRaw = (db.prepare("SELECT value FROM app_meta WHERE key = 'gantt_unit_scale'").get() as { value?: string } | undefined)
      ?.value
    const zoom: 'day' | 'week' | 'month' = zoomRaw === 'week' || zoomRaw === 'month' ? zoomRaw : 'day'
    const scaleNum = Number(scaleRaw ?? 100)
    return {
      selectedProjectName: selected && projects[selected] ? selected : names[0] ?? '',
      projects,
      zoom,
      ganttUnitScalePercent: Number.isFinite(scaleNum) ? Math.max(40, Math.min(1000, Math.round(scaleNum))) : 100,
    }
  } finally {
    db.close()
  }
}

function writeSnapshotViaNativeSqlite(dbFilePath: string, snap: WbsSnapshot) {
  const db = new DatabaseSync(dbFilePath)
  try {
    db.exec(WBS_DDL)
    db.exec('BEGIN IMMEDIATE')
    db.exec('DELETE FROM tasks')
    db.exec('DELETE FROM projects')
    db.exec('DELETE FROM companies')
    const insertProject = db.prepare(
      'INSERT INTO projects (name, company, po_date, issues_json, system_overview_json, mom_json, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const insertTask = db.prepare(
      `INSERT INTO tasks (project_name, id, name, parent_id, task_order, planned_start_date, planned_end_date, actual_start_date, actual_end_date, role, status, progress, mh_md)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertCompany = db.prepare('INSERT OR IGNORE INTO companies (name) VALUES (?)')
    const names = Object.keys(snap.projects)
    names.forEach((name, idx) => {
      const b = snap.projects[name]
      insertProject.run(
        name,
        b.company ?? '',
        b.po_date ?? '',
        JSON.stringify(b.issues ?? []),
        JSON.stringify(b.system_overview ?? []),
        JSON.stringify({ docs: b.mom_documents ?? [] }),
        idx,
      )
      for (const t of b.tasks ?? []) {
        insertTask.run(
          name,
          Number(t.id ?? 0),
          String(t.name ?? ''),
          t.parent_id == null ? null : Number(t.parent_id),
          Number(t.order ?? 0),
          String(t.planned_start_date ?? ''),
          String(t.planned_end_date ?? ''),
          String(t.actual_start_date ?? ''),
          String(t.actual_end_date ?? ''),
          String(t.role ?? ''),
          String(t.status ?? 'Not Started'),
          Number(t.progress ?? 0),
          String(t.mh_md ?? ''),
        )
      }
      const c = String(b.company ?? '').trim()
      if (c) insertCompany.run(c)
    })
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('selected_project_name', ?)").run(snap.selectedProjectName ?? '')
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('zoom', ?)").run(snap.zoom ?? 'day')
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('gantt_unit_scale', ?)").run(
      String(Math.max(40, Math.min(1000, Math.round(Number(snap.ganttUnitScalePercent ?? 100))))),
    )
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '1')").run()
    db.exec('COMMIT')
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw e
  } finally {
    db.close()
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function appendBackupLog(event: string, details?: Record<string, string | number | boolean | null | undefined>) {
  try {
    fs.mkdirSync(WBS_DATA_DIR, { recursive: true })
    const payload = {
      ts: nowIso(),
      event,
      ...(details ?? {}),
    }
    fs.appendFileSync(WBS_BACKUP_LOG_FILE, `${JSON.stringify(payload)}\n`, 'utf8')
  } catch {
    /* ignore logging failures */
  }
}

function makeBackupFileName(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  return `wbs-${y}${m}${d}-${hh}${mm}${ss}-${ms}.db`
}

function latestBackupTimestampMs(): number | null {
  if (!fs.existsSync(WBS_BACKUP_DIR)) return null
  const rex = /^wbs-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})\.db$/
  const legacyRex = /^wbs-(\d{4})(\d{2})(\d{2})\.db$/
  let latest: number | null = null
  for (const name of fs.readdirSync(WBS_BACKUP_DIR)) {
    if (!name.endsWith('.db')) continue
    const m = rex.exec(name)
    if (m) {
      const ts = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
        Number(m[7]),
      ).getTime()
      if (Number.isFinite(ts)) latest = latest == null ? ts : Math.max(latest, ts)
      continue
    }
    const legacy = legacyRex.exec(name)
    if (legacy) {
      const ts = new Date(Number(legacy[1]), Number(legacy[2]) - 1, Number(legacy[3]), 0, 0, 0, 0).getTime()
      if (Number.isFinite(ts)) latest = latest == null ? ts : Math.max(latest, ts)
    }
  }
  return latest
}

function backupCurrentDbIfExists(force = false) {
  if (!fs.existsSync(WBS_DB_FILE)) {
    appendBackupLog('backup.skip', { reason: 'db_not_found' })
    return
  }
  const stat = fs.statSync(WBS_DB_FILE)
  if (stat.size <= 0) {
    appendBackupLog('backup.skip', { reason: 'db_empty' })
    return
  }
  fs.mkdirSync(WBS_BACKUP_DIR, { recursive: true })
  if (!force) {
    const latestTs = latestBackupTimestampMs()
    if (latestTs != null) {
      const elapsed = Date.now() - latestTs
      if (elapsed < WBS_BACKUP_MIN_INTERVAL_MS) {
        appendBackupLog('backup.skip', {
          reason: 'min_interval',
          elapsed_ms: elapsed,
          min_interval_ms: WBS_BACKUP_MIN_INTERVAL_MS,
        })
        return
      }
    }
  }
  let backupPath = path.join(WBS_BACKUP_DIR, makeBackupFileName())
  while (fs.existsSync(backupPath)) {
    backupPath = path.join(WBS_BACKUP_DIR, makeBackupFileName(new Date()))
  }
  fs.copyFileSync(WBS_DB_FILE, backupPath)
  appendBackupLog('backup.create', { file: path.basename(backupPath), bytes: stat.size })
  const backups = fs
    .readdirSync(WBS_BACKUP_DIR)
    .filter((name) => name.endsWith('.db'))
    .sort()
  if (backups.length <= WBS_BACKUP_KEEP_GENERATIONS) return
  const stale = backups.slice(0, backups.length - WBS_BACKUP_KEEP_GENERATIONS)
  for (const name of stale) {
    try {
      fs.unlinkSync(path.join(WBS_BACKUP_DIR, name))
      appendBackupLog('backup.prune', { file: name })
    } catch {
      /* ignore cleanup errors */
    }
  }
}

function listBackupDates(): string[] {
  if (!fs.existsSync(WBS_BACKUP_DIR)) return []
  const rex = /^wbs-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})\.db$/
  const legacyRex = /^wbs-(\d{4})(\d{2})(\d{2})\.db$/
  return fs
    .readdirSync(WBS_BACKUP_DIR)
    .map((name) => {
      const m = rex.exec(name)
      if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}.${m[7]}`
      const legacy = legacyRex.exec(name)
      if (legacy) return `${legacy[1]}-${legacy[2]}-${legacy[3]}`
      return null
    })
    .filter((v): v is string => Boolean(v))
    .sort((a, b) => b.localeCompare(a))
}

function backupPathFromIsoDate(date: string): string | null {
  const normalized = date.trim()
  const withTime = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(normalized)
  if (withTime) {
    return path.join(
      WBS_BACKUP_DIR,
      `wbs-${withTime[1]}${withTime[2]}${withTime[3]}-${withTime[4]}${withTime[5]}${withTime[6]}-${withTime[7]}.db`,
    )
  }
  const legacy = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized)
  if (legacy) return path.join(WBS_BACKUP_DIR, `wbs-${legacy[1]}${legacy[2]}${legacy[3]}.db`)
  return null
}

function looksLikeSqliteBytes(buf: Uint8Array): boolean {
  if (buf.byteLength < 16) return false
  const head = new TextDecoder('ascii').decode(buf.subarray(0, 15))
  return head === 'SQLite format 3'
}





async function readProjectCountFromDbBytes(bytes: Uint8Array): Promise<number | null> {
  if (!looksLikeSqliteBytes(bytes)) return null
  try {
    const SQL = await getSqlModule()
    const db = new SQL.Database(bytes)
    const r = db.exec('SELECT COUNT(*) AS c FROM projects')
    db.close()
    if (!r.length || !r[0].values.length) return 0
    return Number(r[0].values[0][0]) || 0
  } catch {
    return null
  }
}

function wbsSqliteFileMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const reqUrl = req.url ?? ''
    const url = reqUrl.split('?')[0]
    if (url !== WBS_DB_ROUTE && url !== WBS_BACKUPS_ROUTE && url !== WBS_RESTORE_ROUTE && url !== WBS_SNAPSHOT_ROUTE) {
      next()
      return
    }

    if (url === WBS_SNAPSHOT_ROUTE && req.method === 'GET') {
      void (async () => {
        try {
          let snap: WbsSnapshot | null = null
          if (fs.existsSync(WBS_DB_FILE)) {
            try {
              snap = readSnapshotViaNativeSqlite(WBS_DB_FILE)
            } catch {
              snap = null
            }
          }
          if (!snap) {
            const backupFiles = fs.existsSync(WBS_BACKUP_DIR)
              ? fs.readdirSync(WBS_BACKUP_DIR).filter((n) => n.endsWith('.db')).sort().reverse()
              : []
            for (const name of backupFiles) {
              try {
                const candidate = path.join(WBS_BACKUP_DIR, name)
                const recovered = readSnapshotViaNativeSqlite(candidate)
                fs.copyFileSync(candidate, WBS_DB_FILE)
                appendBackupLog('api.snapshot.get.recover', { source: name })
                snap = recovered
                break
              } catch {
                /* try next */
              }
            }
          }
          if (!snap) {
            fs.mkdirSync(WBS_DATA_DIR, { recursive: true })
            writeSnapshotViaNativeSqlite(WBS_DB_FILE, {
              selectedProjectName: '',
              projects: {},
              zoom: 'day',
              ganttUnitScalePercent: 100,
            })
            snap = readSnapshotViaNativeSqlite(WBS_DB_FILE)
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify(snap))
        } catch (e) {
          appendBackupLog('api.snapshot.get.fail', { error: e instanceof Error ? e.message : String(e) })
          res.statusCode = 500
          res.end(e instanceof Error ? e.message : 'snapshot read failed')
        }
      })()
      return
    }

    if (url === WBS_SNAPSHOT_ROUTE && req.method === 'PUT') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        void (async () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WbsSnapshot
            if (!payload || typeof payload !== 'object' || !payload.projects || typeof payload.projects !== 'object') {
              res.statusCode = 400
              res.end('invalid snapshot')
              return
            }
            let existingCount = 0
            try {
              existingCount = fs.existsSync(WBS_DB_FILE) ? Object.keys(readSnapshotViaNativeSqlite(WBS_DB_FILE).projects).length : 0
            } catch {
              existingCount = 0
            }
            const incomingCount = Object.keys(payload.projects).length
            if (existingCount > 0 && incomingCount === 0) {
              appendBackupLog('api.snapshot.put.blocked', {
                reason: 'incoming_empty_snapshot',
                existing_projects: existingCount,
                incoming_projects: incomingCount,
              })
              res.statusCode = 409
              res.end('blocked: incoming snapshot is empty while existing DB has data')
              return
            }
            fs.mkdirSync(WBS_DATA_DIR, { recursive: true })
            backupCurrentDbIfExists()
            writeSnapshotViaNativeSqlite(WBS_DB_FILE, payload)
            res.statusCode = 204
            res.end()
          } catch (e) {
            appendBackupLog('api.snapshot.put.fail', { error: e instanceof Error ? e.message : String(e) })
            res.statusCode = 500
            res.end(e instanceof Error ? e.message : 'snapshot write failed')
          }
        })()
      })
      req.on('error', () => {
        appendBackupLog('api.snapshot.put.fail', { error: 'request error' })
        res.statusCode = 500
        res.end('request error')
      })
      return
    }

    if (url === WBS_BACKUPS_ROUTE && req.method === 'GET') {
      try {
        const dates = listBackupDates()
        appendBackupLog('api.backups.get.ok', { count: dates.length })
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ dates }))
      } catch (e) {
        appendBackupLog('api.backups.get.fail', { error: e instanceof Error ? e.message : String(e) })
        res.statusCode = 500
        res.end(e instanceof Error ? e.message : 'backup list failed')
      }
      return
    }

    if (url === WBS_RESTORE_ROUTE && req.method === 'POST') {
      try {
        const date = new URL(reqUrl, 'http://localhost').searchParams.get('date') ?? ''
        const backupPath = backupPathFromIsoDate(date)
        if (!backupPath || !fs.existsSync(backupPath)) {
          appendBackupLog('api.restore.not_found', { date })
          res.statusCode = 404
          res.end('backup not found')
          return
        }
        fs.mkdirSync(WBS_DATA_DIR, { recursive: true })
        backupCurrentDbIfExists(true)
        fs.copyFileSync(backupPath, WBS_DB_FILE)
        const restoredSize = fs.statSync(WBS_DB_FILE).size
        appendBackupLog('api.restore.ok', { date, file: path.basename(backupPath), bytes: restoredSize })
        res.statusCode = 204
        res.end()
      } catch (e) {
        appendBackupLog('api.restore.fail', { error: e instanceof Error ? e.message : String(e) })
        res.statusCode = 500
        res.end(e instanceof Error ? e.message : 'restore failed')
      }
      return
    }

    if (req.method === 'GET') {
      try {
        if (!fs.existsSync(WBS_DB_FILE)) {
          appendBackupLog('api.db.get.not_found')
          res.statusCode = 404
          res.end()
          return
        }
        const buf = fs.readFileSync(WBS_DB_FILE)
        appendBackupLog('api.db.get.ok', { bytes: buf.byteLength })
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-store')
        res.end(buf)
      } catch (e) {
        appendBackupLog('api.db.get.fail', { error: e instanceof Error ? e.message : String(e) })
        res.statusCode = 500
        res.end(e instanceof Error ? e.message : 'read failed')
      }
      return
    }

    if (req.method === 'PUT') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        void (async () => {
          try {
            fs.mkdirSync(WBS_DATA_DIR, { recursive: true })
            const merged = Buffer.concat(chunks)
            const incomingProjects = await readProjectCountFromDbBytes(new Uint8Array(merged))
            if (incomingProjects === null) {
              appendBackupLog('api.db.put.blocked', {
                reason: 'incoming_invalid_sqlite',
                incoming_bytes: merged.byteLength,
              })
              res.statusCode = 400
              res.end('blocked: incoming payload is not a readable sqlite database')
              return
            }
            const existingProjects = fs.existsSync(WBS_DB_FILE)
              ? await readProjectCountFromDbBytes(new Uint8Array(fs.readFileSync(WBS_DB_FILE)))
              : 0
            if (incomingProjects !== null && existingProjects !== null && existingProjects > 0 && incomingProjects === 0) {
              appendBackupLog('api.db.put.blocked', {
                reason: 'incoming_empty_snapshot',
                existing_projects: existingProjects,
                incoming_projects: incomingProjects,
              })
              res.statusCode = 409
              res.end('blocked: incoming snapshot is empty while existing DB has data')
              return
            }
            backupCurrentDbIfExists()
            fs.writeFileSync(WBS_DB_FILE, merged)
            appendBackupLog('api.db.put.ok', { bytes: merged.byteLength })
            res.statusCode = 204
            res.end()
          } catch (e) {
            appendBackupLog('api.db.put.fail', { error: e instanceof Error ? e.message : String(e) })
            res.statusCode = 500
            res.end(e instanceof Error ? e.message : 'write failed')
          }
        })()
      })
      req.on('error', () => {
        appendBackupLog('api.db.put.fail', { error: 'request error' })
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
