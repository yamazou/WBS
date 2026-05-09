// Browser default `sql.js` loads `sql-wasm-browser.wasm`, which is not shipped in the npm
// package, so Vite returns HTML and WASM init fails — persistence never runs. asm.js has no
// separate wasm file and works reliably in dev/preview.
import initSqlJs from 'sql.js/dist/sql-asm.js'
import type { Database } from 'sql.js'
import {
  emptyProjectBundle,
  type MomDocument,
  type IssueItem,
  type MomHeader,
  type MomItem,
  type ProjectBundle,
  type SystemOverviewItem,
  type Task,
  type TaskStatus,
  type ZoomUnit,
} from '../wbsDefaults'

/** Legacy single-blob import only (not shown as an app default). */
const LEGACY_IMPORT_PROJECT_NAME = 'Imported Project'
import { WBS_DDL } from './wbsSchemaSql'

export const LEGACY_TASKS_STORAGE_KEY = 'wbs-gantt-tasks-v1'
export const PROJECTS_STORAGE_KEY = 'wbs-gantt-projects-v1'
export const ZOOM_STORAGE_KEY = 'wbs-gantt-zoom-v1'
export const GANTT_UNIT_SCALE_STORAGE_KEY = 'wbs-gantt-unit-scale-v1'

/** Timeline column width scale (%). Applied to Day/Week/Month unit pixel width. */
export const GANTT_UNIT_SCALE_MIN = 40
export const GANTT_UNIT_SCALE_MAX = 1000
export const GANTT_UNIT_SCALE_DEFAULT = 100

export function clampGanttUnitScale(n: number): number {
  if (!Number.isFinite(n)) return GANTT_UNIT_SCALE_DEFAULT
  return Math.min(GANTT_UNIT_SCALE_MAX, Math.max(GANTT_UNIT_SCALE_MIN, Math.round(n)))
}

export function readGanttUnitScaleFromLocalStorage(): number {
  try {
    const s = localStorage.getItem(GANTT_UNIT_SCALE_STORAGE_KEY)
    if (s != null && s !== '') return clampGanttUnitScale(Number(s))
  } catch {
    /* ignore */
  }
  return GANTT_UNIT_SCALE_DEFAULT
}

/** `npm run dev` / `vite preview`: SQLite is stored at `<repo>/.wbs-data/wbs.db` (Vite middleware). */
export const WBS_REPO_SQLITE_PATH = '.wbs-data/wbs.db'
const REPO_FILE_API = '/__wbs_sqlite/db'

/** Former IndexedDB store name; delete so no stale copy remains in the browser. */
const LEGACY_INDEXEDDB_NAME = 'wbs-sqlite-store-v1'

function purgeLegacyIndexedDb(): void {
  if (typeof indexedDB === 'undefined') return
  try {
    indexedDB.deleteDatabase(LEGACY_INDEXEDDB_NAME)
  } catch {
    /* ignore */
  }
}

function looksLikeSqliteDb(buf: Uint8Array): boolean {
  if (buf.byteLength < 16) return false
  const head = new TextDecoder('ascii').decode(buf.subarray(0, 15))
  return head === 'SQLite format 3'
}

/** Load DB bytes from repo file only (`GET /__wbs_sqlite/db`). No IndexedDB. */
async function loadPersistedBytes(): Promise<Uint8Array | null> {
  try {
    const r = await fetch(REPO_FILE_API, { cache: 'no-store' })
    if (r.status === 404) return null
    if (!r.ok) {
      console.warn(
        `[wbs] GET ${REPO_FILE_API} HTTP ${r.status} — starting empty in memory. Use npm run dev or vite preview to use ${WBS_REPO_SQLITE_PATH}.`,
      )
      return null
    }
    const buf = new Uint8Array(await r.arrayBuffer())
    if (!looksLikeSqliteDb(buf)) {
      console.warn(`[wbs] GET ${REPO_FILE_API} returned a non-SQLite body — starting empty.`)
      return null
    }
    return buf
  } catch (err) {
    console.warn(
      `[wbs] GET ${REPO_FILE_API} failed (${err instanceof Error ? err.message : String(err)}). ` +
        `Starting empty in memory; persistence requires Vite dev or preview.`,
    )
    return null
  }
}

/** Persist DB bytes to repo file only (`PUT /__wbs_sqlite/db`). Throws if the file cannot be written. */
async function savePersistedBytes(data: Uint8Array): Promise<void> {
  const body = new Blob([new Uint8Array(data)])
  const r = await fetch(REPO_FILE_API, {
    method: 'PUT',
    body,
    headers: { 'Content-Type': 'application/octet-stream' },
    keepalive: body.size <= 60_000,
  })
  if (r.status !== 204) {
    let detail = ''
    try {
      detail = (await r.text()).trim()
    } catch {
      detail = ''
    }
    throw new Error(
      `[wbs] PUT ${REPO_FILE_API} failed (HTTP ${r.status})${detail ? `: ${detail}` : ''}. Close apps locking ${WBS_REPO_SQLITE_PATH} and use npm run dev.`,
    )
  }
}

export type WbsPersistedSnapshot = {
  selectedProjectName: string
  projects: Record<string, ProjectBundle>
  zoom: ZoomUnit
  /** 100 = default; scales Gantt column pixel width (Day/Week/Month). */
  ganttUnitScalePercent: number
}

let sqlModulePromise: ReturnType<typeof initSqlJs> | null = null

async function getSql(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!sqlModulePromise) {
    sqlModulePromise = initSqlJs()
  }
  return sqlModulePromise
}

function migrateTasksMhMdColumn(db: Database) {
  try {
    const r = db.exec('PRAGMA table_info(tasks)')
    if (!r.length || !r[0].values.length) return
    const colNames = r[0].values.map((row) => String((row as unknown[])[1]))
    if (colNames.includes('mh_md')) return
    db.run(`ALTER TABLE tasks ADD COLUMN mh_md TEXT NOT NULL DEFAULT ''`)
  } catch {
    /* ignore */
  }
}

function migrateProjectsPoDateColumn(db: Database) {
  try {
    const r = db.exec('PRAGMA table_info(projects)')
    if (!r.length || !r[0].values.length) return
    const colNames = r[0].values.map((row) => String((row as unknown[])[1]))
    if (colNames.includes('po_date')) return
    db.run(`ALTER TABLE projects ADD COLUMN po_date TEXT NOT NULL DEFAULT ''`)
  } catch {
    /* ignore */
  }
}

function migrateProjectsIssuesColumn(db: Database) {
  try {
    const r = db.exec('PRAGMA table_info(projects)')
    if (!r.length || !r[0].values.length) return
    const colNames = r[0].values.map((row) => String((row as unknown[])[1]))
    if (colNames.includes('issues_json')) return
    db.run(`ALTER TABLE projects ADD COLUMN issues_json TEXT NOT NULL DEFAULT '[]'`)
  } catch {
    /* ignore */
  }
}

function migrateProjectsSystemOverviewColumn(db: Database) {
  try {
    const r = db.exec('PRAGMA table_info(projects)')
    if (!r.length || !r[0].values.length) return
    const colNames = r[0].values.map((row) => String((row as unknown[])[1]))
    if (colNames.includes('system_overview_json')) return
    db.run(`ALTER TABLE projects ADD COLUMN system_overview_json TEXT NOT NULL DEFAULT '[]'`)
  } catch {
    /* ignore */
  }
}

function migrateProjectsMomColumn(db: Database) {
  try {
    const r = db.exec('PRAGMA table_info(projects)')
    if (!r.length || !r[0].values.length) return
    const colNames = r[0].values.map((row) => String((row as unknown[])[1]))
    if (colNames.includes('mom_json')) return
    db.run(`ALTER TABLE projects ADD COLUMN mom_json TEXT NOT NULL DEFAULT '{}'`)
  } catch {
    try {
      db.run(`ALTER TABLE projects ADD COLUMN mom_json TEXT`)
    } catch {
      /* ignore */
    }
  }
}

function ensureSchema(db: Database) {
  db.exec(WBS_DDL)
  migrateProjectsPoDateColumn(db)
  migrateProjectsIssuesColumn(db)
  migrateProjectsSystemOverviewColumn(db)
  migrateProjectsMomColumn(db)
  migrateTasksMhMdColumn(db)
}

function hasProjectsColumn(db: Database, columnName: string): boolean {
  try {
    const r = db.exec('PRAGMA table_info(projects)')
    if (!r.length || !r[0].values.length) return false
    const colNames = r[0].values.map((row) => String((row as unknown[])[1]))
    return colNames.includes(columnName)
  } catch {
    return false
  }
}

function normalizeIssues(raw: unknown): IssueItem[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item, idx) => {
    const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    return {
      id: Number(o.id ?? idx + 1),
      status: String(o.status ?? ''),
      type: String(o.type ?? ''),
      issued_by: String(o.issued_by ?? ''),
      issue: String(o.issue ?? ''),
      due_date: String(o.due_date ?? ''),
      pic: String(o.pic ?? ''),
      created_on: String(o.created_on ?? ''),
      updated_on: String(o.updated_on ?? ''),
      progress: String(o.progress ?? ''),
    }
  })
}

function normalizeSystemOverview(raw: unknown): SystemOverviewItem[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item, idx) => {
    const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    return {
      id: Number(o.id ?? idx + 1),
      title: String(o.title ?? ''),
      image_data_url: String(o.image_data_url ?? ''),
      description: String(o.description ?? ''),
    }
  })
}

function normalizeMomHeader(raw: unknown): MomHeader {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    title: String(o.title ?? ''),
    date: String(o.date ?? ''),
    time: String(o.time ?? ''),
    attendance: String(o.attendance ?? ''),
    location: String(o.location ?? ''),
  }
}

function normalizeMomItems(raw: unknown): MomItem[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item, idx) => {
    const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    return {
      id: Number(o.id ?? idx + 1),
      type: String(o.type ?? ''),
      content: String(o.content ?? ''),
      issue_list_no: String(o.issue_list_no ?? ''),
      pic: String(o.pic ?? ''),
      due_date: String(o.due_date ?? ''),
      remarks: String(o.remarks ?? ''),
    }
  })
}

function normalizeMomDocuments(raw: unknown): MomDocument[] {
  if (!Array.isArray(raw)) return []
  return raw.map((doc, idx) => {
    const o = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {}
    return {
      id: Number(o.id ?? idx + 1),
      header: normalizeMomHeader(o.header),
      items: normalizeMomItems(o.items),
    }
  })
}

function projectCount(db: Database): number {
  const r = db.exec('SELECT COUNT(*) AS c FROM projects')
  if (!r.length || !r[0].values.length) return 0
  return Number(r[0].values[0][0]) || 0
}

function projectNames(db: Database): string[] {
  const r = db.exec('SELECT name FROM projects ORDER BY sort_order ASC, name ASC')
  if (!r.length || !r[0].values.length) return []
  return r[0].values.map((row) => String(row[0] ?? ''))
}

/**
 * Historical fallback:
 * If DB only has legacy `Imported Project` while richer multi-project data still remains in localStorage,
 * re-run migration from localStorage to recover the full project list.
 */
function shouldBackfillFromProjectsStorage(db: Database): boolean {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(PROJECTS_STORAGE_KEY)
  } catch {
    return false
  }
  if (!saved) return false
  try {
    const parsed = JSON.parse(saved) as { projects?: Record<string, unknown> }
    const lsProjects = parsed.projects && typeof parsed.projects === 'object' ? Object.keys(parsed.projects) : []
    if (lsProjects.length === 0) return false
  } catch {
    return false
  }
  const names = projectNames(db)
  return names.length === 1 && names[0] === LEGACY_IMPORT_PROJECT_NAME
}

function normalizeEntry(raw: unknown, parseTasks: (s: string | null) => Task[]): ProjectBundle | null {
  if (Array.isArray(raw)) {
    return emptyProjectBundle(parseTasks(JSON.stringify(raw)))
  }
  if (raw && typeof raw === 'object' && 'tasks' in raw) {
    const o = raw as {
      tasks?: unknown
      company?: unknown
      po_date?: unknown
      issues?: unknown
      system_overview?: unknown
      mom_json?: unknown
      mom_header?: unknown
      mom_items?: unknown
    }
    const docsFromJson = (() => {
      const mj = o.mom_json
      if (!mj || typeof mj !== 'object') return []
      const m = mj as { docs?: unknown; header?: unknown; items?: unknown }
      const docs = normalizeMomDocuments(m.docs)
      if (docs.length > 0) return docs
      const legacyHeader = normalizeMomHeader(m.header)
      const legacyItems = normalizeMomItems(m.items)
      if (
        legacyHeader.title ||
        legacyHeader.date ||
        legacyHeader.time ||
        legacyHeader.attendance ||
        legacyHeader.location ||
        legacyItems.length
      ) {
        return [{ id: 1, header: legacyHeader, items: legacyItems }]
      }
      return []
    })()
    return {
      tasks: parseTasks(JSON.stringify(o.tasks ?? [])),
      company: typeof o.company === 'string' ? o.company : '',
      po_date: typeof o.po_date === 'string' ? o.po_date : '',
      issues: normalizeIssues(o.issues),
      system_overview: normalizeSystemOverview(o.system_overview),
      mom_documents:
        docsFromJson.length > 0
          ? docsFromJson
          : (() => {
              const legacyHeader = normalizeMomHeader(o.mom_header)
              const legacyItems = normalizeMomItems(o.mom_items)
              if (
                legacyHeader.title ||
                legacyHeader.date ||
                legacyHeader.time ||
                legacyHeader.attendance ||
                legacyHeader.location ||
                legacyItems.length
              ) {
                return [{ id: 1, header: legacyHeader, items: legacyItems }]
              }
              return []
            })(),
    }
  }
  return null
}

export function readLegacyProjectsFromLocalStorage(
  parseTasks: (s: string | null) => Task[],
): { selectedProjectName: string; projects: Record<string, ProjectBundle> } | null {
  const saved = localStorage.getItem(PROJECTS_STORAGE_KEY)
  if (!saved) return null
  try {
    const parsed = JSON.parse(saved) as {
      selectedProjectName?: string
      projects?: Record<string, unknown>
    }
    if (!parsed.projects || typeof parsed.projects !== 'object') return null
    const normalizedProjects: Record<string, ProjectBundle> = {}
    for (const [name, raw] of Object.entries(parsed.projects)) {
      const bundle = normalizeEntry(raw, parseTasks)
      if (bundle) normalizedProjects[name] = bundle
    }
    const names = Object.keys(normalizedProjects)
    if (names.length === 0) return null
    const selectedProjectName =
      parsed.selectedProjectName && normalizedProjects[parsed.selectedProjectName]
        ? parsed.selectedProjectName
        : names[0]
    return { selectedProjectName, projects: normalizedProjects }
  } catch {
    return null
  }
}

function migrateFromLocalStorage(db: Database, parseTasks: (s: string | null) => Task[]) {
  const saved = localStorage.getItem(PROJECTS_STORAGE_KEY)
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as {
        selectedProjectName?: string
        projects?: Record<string, unknown>
      }
      if (parsed.projects && typeof parsed.projects === 'object') {
        const normalizedProjects: Record<string, ProjectBundle> = {}
        for (const [name, raw] of Object.entries(parsed.projects)) {
          const bundle = normalizeEntry(raw, parseTasks)
          if (bundle) normalizedProjects[name] = bundle
        }
        const names = Object.keys(normalizedProjects)
        if (names.length > 0) {
          writeSnapshotToDb(db, {
            selectedProjectName:
              parsed.selectedProjectName && normalizedProjects[parsed.selectedProjectName]
                ? parsed.selectedProjectName
                : names[0],
            projects: normalizedProjects,
            zoom: readZoomFromLocalStorage(),
            ganttUnitScalePercent: readGanttUnitScaleFromLocalStorage(),
          })
          localStorage.removeItem(PROJECTS_STORAGE_KEY)
          return
        }
      }
    } catch {
      /* fall through */
    }
  }

  const legacyTasks = parseTasks(localStorage.getItem(LEGACY_TASKS_STORAGE_KEY))
  writeSnapshotToDb(db, {
    selectedProjectName: LEGACY_IMPORT_PROJECT_NAME,
    projects: { [LEGACY_IMPORT_PROJECT_NAME]: emptyProjectBundle(legacyTasks) },
    zoom: readZoomFromLocalStorage(),
    ganttUnitScalePercent: readGanttUnitScaleFromLocalStorage(),
  })
  localStorage.removeItem(LEGACY_TASKS_STORAGE_KEY)
}

function readZoomFromLocalStorage(): ZoomUnit {
  const savedZoom = localStorage.getItem(ZOOM_STORAGE_KEY)
  if (savedZoom === 'day' || savedZoom === 'week' || savedZoom === 'month') return savedZoom
  return 'day'
}

function readMeta(db: Database, key: string): string | null {
  const stmt = db.prepare('SELECT value FROM app_meta WHERE key = ?')
  stmt.bind([key])
  let v: string | null = null
  if (stmt.step()) {
    const row = stmt.getAsObject() as { value?: string }
    v = typeof row.value === 'string' ? row.value : null
  }
  stmt.free()
  return v
}

function writeMeta(db: Database, key: string, value: string) {
  db.run('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)', [key, value])
}

function readSnapshotFromDb(db: Database): WbsPersistedSnapshot {
  const hasMomJson = hasProjectsColumn(db, 'mom_json')
  const projRes = db.exec(
    hasMomJson
      ? 'SELECT name, company, po_date, issues_json, system_overview_json, mom_json FROM projects ORDER BY sort_order ASC, name ASC'
      : 'SELECT name, company, po_date, issues_json, system_overview_json FROM projects ORDER BY sort_order ASC, name ASC',
  )
  const projects: Record<string, ProjectBundle> = {}
  const names: string[] = []
  if (projRes.length && projRes[0].values.length) {
    for (const row of projRes[0].values) {
      const name = String(row[0])
      const company = String(row[1] ?? '')
      const poDate = String(row[2] ?? '')
      const issuesJson = String(row[3] ?? '[]')
      const systemOverviewJson = String(row[4] ?? '[]')
      const momJson = String(
        row[5] ?? '{"header":{"title":"","date":"","time":"","attendance":"","location":""},"items":[]}',
      )
      names.push(name)
      const stmt = db.prepare(
        `SELECT id, name, parent_id, task_order, planned_start_date, planned_end_date, actual_start_date, actual_end_date, role, status, progress, mh_md
         FROM tasks WHERE project_name = ? ORDER BY task_order ASC, id ASC`,
      )
      stmt.bind([name])
      const tasks: Task[] = []
      while (stmt.step()) {
        const row = stmt.get() as unknown[]
        const [
          id,
          tname,
          parentId,
          taskOrder,
          ps,
          pe,
          actStart,
          actEnd,
          role,
          status,
          progress,
          mhMd,
        ] = row
        tasks.push({
          id: Number(id),
          name: String(tname ?? ''),
          parent_id: parentId === null || parentId === undefined ? null : Number(parentId),
          order: Number(taskOrder ?? 0),
          planned_start_date: String(ps ?? ''),
          planned_end_date: String(pe ?? ''),
          actual_start_date: String(actStart ?? ''),
          actual_end_date: String(actEnd ?? ''),
          role: String(role ?? ''),
          status:
            status === 'Finished' || status === 'Not Started'
              ? (status as TaskStatus)
              : status === 'On process'
                ? 'In Process'
                : status === 'In Process'
                  ? status
              : 'Not Started',
          progress: Number(progress ?? 0),
          mh_md: String(mhMd ?? ''),
        })
      }
      stmt.free()
      let issues: IssueItem[] = []
      let systemOverview: SystemOverviewItem[] = []
      let momDocs: MomDocument[] = []
      try {
        issues = normalizeIssues(JSON.parse(issuesJson))
      } catch {
        issues = []
      }
      try {
        systemOverview = normalizeSystemOverview(JSON.parse(systemOverviewJson))
      } catch {
        systemOverview = []
      }
      try {
        const parsedMom = JSON.parse(momJson) as { header?: unknown; items?: unknown }
        const docs = normalizeMomDocuments((parsedMom as { docs?: unknown }).docs)
        if (docs.length > 0) {
          momDocs = docs
        } else {
          const legacyHeader = normalizeMomHeader(parsedMom.header)
          const legacyItems = normalizeMomItems(parsedMom.items)
          if (
            legacyHeader.title ||
            legacyHeader.date ||
            legacyHeader.time ||
            legacyHeader.attendance ||
            legacyHeader.location ||
            legacyItems.length
          ) {
            momDocs = [{ id: 1, header: legacyHeader, items: legacyItems }]
          } else {
            momDocs = []
          }
        }
      } catch {
        momDocs = []
      }
      projects[name] = {
        tasks,
        company,
        po_date: poDate,
        issues,
        system_overview: systemOverview,
        mom_documents: momDocs,
      }
    }
  }

  let selected = readMeta(db, 'selected_project_name') ?? ''
  if (!selected || !projects[selected]) {
    selected = names[0] ?? ''
  }

  const z = readMeta(db, 'zoom')
  const zoom: ZoomUnit = z === 'day' || z === 'week' || z === 'month' ? z : 'day'

  const scaleRaw = readMeta(db, 'gantt_unit_scale')
  const ganttUnitScalePercent =
    scaleRaw != null && scaleRaw !== '' ? clampGanttUnitScale(Number(scaleRaw)) : readGanttUnitScaleFromLocalStorage()

  return { selectedProjectName: selected, projects, zoom, ganttUnitScalePercent }
}

function writeSnapshotToDb(db: Database, snap: WbsPersistedSnapshot) {
  db.exec('PRAGMA foreign_keys = ON;')
  db.run('BEGIN IMMEDIATE')
  try {
    db.run('DELETE FROM tasks')
    db.run('DELETE FROM projects')
    db.run('DELETE FROM companies')

    const hasMomJson = hasProjectsColumn(db, 'mom_json')
    const names = Object.keys(snap.projects)
    names.forEach((name, idx) => {
      const bundle = snap.projects[name]
      if (hasMomJson) {
        db.run(
          'INSERT INTO projects (name, company, po_date, issues_json, system_overview_json, mom_json, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            name,
            bundle.company ?? '',
            bundle.po_date ?? '',
            JSON.stringify(bundle.issues ?? []),
            JSON.stringify(bundle.system_overview ?? []),
            JSON.stringify({
            docs: bundle.mom_documents ?? [],
            }),
            idx,
          ],
        )
      } else {
        db.run(
          'INSERT INTO projects (name, company, po_date, issues_json, system_overview_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
          [name, bundle.company ?? '', bundle.po_date ?? '', JSON.stringify(bundle.issues ?? []), JSON.stringify(bundle.system_overview ?? []), idx],
        )
      }
      const ins = db.prepare(
        `INSERT INTO tasks (project_name, id, name, parent_id, task_order, planned_start_date, planned_end_date, actual_start_date, actual_end_date, role, status, progress, mh_md)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const t of bundle.tasks) {
        ins.run([
          name,
          t.id,
          t.name,
          t.parent_id,
          t.order,
          t.planned_start_date,
          t.planned_end_date,
          t.actual_start_date,
          t.actual_end_date,
          t.role,
          t.status,
          t.progress,
          t.mh_md ?? '',
        ])
      }
      ins.free()
    })

    const companySet = new Set<string>()
    for (const b of Object.values(snap.projects)) {
      const c = (b.company ?? '').trim()
      if (c) companySet.add(c)
    }
    const cIns = db.prepare('INSERT OR IGNORE INTO companies (name) VALUES (?)')
    for (const c of companySet) {
      cIns.run([c])
    }
    cIns.free()

    writeMeta(db, 'selected_project_name', snap.selectedProjectName)
    writeMeta(db, 'zoom', snap.zoom)
    writeMeta(db, 'gantt_unit_scale', String(clampGanttUnitScale(snap.ganttUnitScalePercent)))
    writeMeta(db, 'schema_version', '1')

    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }
}

export function emptyDefaultSnapshot(): WbsPersistedSnapshot {
  return {
    selectedProjectName: '',
    projects: {},
    zoom: 'day',
    ganttUnitScalePercent: GANTT_UNIT_SCALE_DEFAULT,
  }
}

export type WbsDbApi = {
  readSnapshot: () => WbsPersistedSnapshot
  persistSnapshot: (snap: WbsPersistedSnapshot) => Promise<void>
  close: () => void
}

export async function openWbsSqlite(
  parseTasks: (s: string | null) => Task[],
  signal?: AbortSignal,
): Promise<WbsDbApi> {
  purgeLegacyIndexedDb()
  const SQL = await getSql()
  const bytes = await loadPersistedBytes()
  const db = bytes && bytes.byteLength > 0 ? new SQL.Database(bytes) : new SQL.Database()
  ensureSchema(db)

  if (projectCount(db) === 0 || shouldBackfillFromProjectsStorage(db)) {
    migrateFromLocalStorage(db, parseTasks)
    if (projectCount(db) === 0) {
      writeSnapshotToDb(db, emptyDefaultSnapshot())
    }
    // React Strict Mode aborts the first in-flight open; writing here would overwrite
    // a newer on-disk DB after the user has already persisted from the second open().
    if (!signal?.aborted) {
      try {
        await savePersistedBytes(db.export())
      } catch (err) {
        console.warn(
          '[wbs] Initial write to repo file failed; using in-memory DB only until the next successful save.',
          err,
        )
      }
    }
  }

  const api: WbsDbApi = {
    readSnapshot: () => readSnapshotFromDb(db),
    persistSnapshot: async (snap) => {
      writeSnapshotToDb(db, snap)
      await savePersistedBytes(db.export())
      try {
        localStorage.setItem(ZOOM_STORAGE_KEY, snap.zoom)
        localStorage.setItem(GANTT_UNIT_SCALE_STORAGE_KEY, String(clampGanttUnitScale(snap.ganttUnitScalePercent)))
      } catch {
        /* ignore quota */
      }
    },
    close: () => {
      try {
        db.close()
      } catch {
        /* ignore double-close */
      }
    },
  }
  return api
}
