import type { Task, ZoomUnit, ProjectBundle } from '../wbsDefaults'
import { clampGanttUnitScale } from './wbsSqlite'

const SNAPSHOT_API = '/__wbs_sqlite/snapshot'

export type WbsPersistedSnapshot = {
  selectedProjectName: string
  projects: Record<string, ProjectBundle>
  zoom: ZoomUnit
  ganttUnitScalePercent: number
}

export type WbsDbApi = {
  readSnapshot: () => WbsPersistedSnapshot
  persistSnapshot: (snap: WbsPersistedSnapshot) => Promise<void>
  close: () => void
}

function emptyDefaultSnapshot(): WbsPersistedSnapshot {
  return { selectedProjectName: '', projects: {}, zoom: 'day', ganttUnitScalePercent: 100 }
}

function normalizeSnapshot(raw: unknown): WbsPersistedSnapshot {
  if (!raw || typeof raw !== 'object') return emptyDefaultSnapshot()
  const o = raw as Record<string, unknown>
  const projectsRaw = o.projects && typeof o.projects === 'object' ? (o.projects as Record<string, unknown>) : {}
  const projects: Record<string, ProjectBundle> = {}
  for (const [name, val] of Object.entries(projectsRaw)) {
    const b = val && typeof val === 'object' ? (val as Record<string, unknown>) : {}
    const tasksRaw = Array.isArray(b.tasks) ? b.tasks : []
    const tasks: Task[] = tasksRaw.map((t, idx) => {
      const x = t && typeof t === 'object' ? (t as Record<string, unknown>) : {}
      return {
        id: Number(x.id ?? idx + 1),
        name: String(x.name ?? ''),
        parent_id: x.parent_id == null ? null : Number(x.parent_id),
        order: Number(x.order ?? 0),
        planned_start_date: String(x.planned_start_date ?? ''),
        planned_end_date: String(x.planned_end_date ?? ''),
        actual_start_date: String(x.actual_start_date ?? ''),
        actual_end_date: String(x.actual_end_date ?? ''),
        role: String(x.role ?? ''),
        status: (String(x.status ?? 'Not Started') as Task['status']),
        progress: Number(x.progress ?? 0),
        mh_md: String(x.mh_md ?? ''),
      }
    })
    projects[name] = {
      tasks,
      company: String(b.company ?? ''),
      po_date: String(b.po_date ?? ''),
      issues: Array.isArray(b.issues) ? (b.issues as ProjectBundle['issues']) : [],
      system_overview: Array.isArray(b.system_overview) ? (b.system_overview as ProjectBundle['system_overview']) : [],
      mom_documents: Array.isArray(b.mom_documents) ? (b.mom_documents as ProjectBundle['mom_documents']) : [],
    }
  }
  const zoomRaw = String(o.zoom ?? 'day')
  const zoom: ZoomUnit = zoomRaw === 'week' || zoomRaw === 'month' ? zoomRaw : 'day'
  const selectedProjectName = String(o.selectedProjectName ?? '')
  const ganttUnitScalePercent = clampGanttUnitScale(Number(o.ganttUnitScalePercent ?? 100))
  return {
    selectedProjectName: projects[selectedProjectName] ? selectedProjectName : Object.keys(projects)[0] ?? '',
    projects,
    zoom,
    ganttUnitScalePercent,
  }
}

export async function openWbsSqlite(
  _parseTasks: (s: string | null) => Task[],
  _signal?: AbortSignal,
): Promise<WbsDbApi> {
  let current = emptyDefaultSnapshot()
  const r = await fetch(SNAPSHOT_API, { cache: 'no-store' })
  if (r.ok) {
    current = normalizeSnapshot(await r.json())
  } else if (r.status !== 404) {
    const detail = await r.text().catch(() => '')
    throw new Error(`snapshot get failed HTTP ${r.status}${detail ? `: ${detail}` : ''}`)
  }
  return {
    readSnapshot: () => current,
    persistSnapshot: async (snap) => {
      const zoom: ZoomUnit = snap.zoom === 'week' || snap.zoom === 'month' ? snap.zoom : 'day'
      const next = {
        ...snap,
        zoom,
        ganttUnitScalePercent: clampGanttUnitScale(snap.ganttUnitScalePercent),
      }
      const res = await fetch(SNAPSHOT_API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(next),
      })
      if (res.status !== 204) {
        const detail = await res.text().catch(() => '')
        throw new Error(`snapshot put failed HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
      }
      current = next
    },
    close: () => {
      /* no-op: server-side sqlite owns resources */
    },
  }
}
