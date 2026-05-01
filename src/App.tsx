import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import './App.css'
import logoImg from './assets/wbs-viewer-logo.png'
import {
  emptyProjectBundle,
  initialTasks,
  NEW_PROJECT_DEFAULT_TASKS,
  type ProjectBundle,
  type Task,
  type TaskStatus,
  type ZoomUnit,
} from './wbsDefaults'
import { emptyDefaultSnapshot, openWbsSqlite, ZOOM_STORAGE_KEY, type WbsDbApi } from './lib/wbsSqlite'

const DAY_MS = 24 * 60 * 60 * 1000
const ZOOM_CONFIG: Record<ZoomUnit, { unitWidth: number; minWidth: number; label: string }> = {
  day: { unitWidth: 34, minWidth: 720, label: 'Day' },
  week: { unitWidth: 56, minWidth: 720, label: 'Week' },
  month: { unitWidth: 92, minWidth: 720, label: 'Month' },
}

/** Local calendar midnight for `YYYY-MM-DD` (matches `<input type="date">`); avoids UTC parse shift on the bar / axis. */
function parseTaskDate(value: string): number | null {
  const trimmed = value.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (m) {
    const y = Number(m[1])
    const mo = Number(m[2]) - 1
    const d = Number(m[3])
    const t = new Date(y, mo, d).getTime()
    return Number.isNaN(t) ? null : t
  }
  const t = new Date(trimmed).getTime()
  return Number.isNaN(t) ? null : t
}

/** WBS caption segment like `2/Apr` (day / short month). */
function formatPoDateForHeader(iso: string): string {
  const trimmed = iso.trim()
  if (!trimmed) return ''
  const t = parseTaskDate(trimmed)
  if (t === null) return trimmed
  const d = new Date(t)
  return `${d.getDate()}/${d.toLocaleString('en-GB', { month: 'short' })}`
}

const plannedEndFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
/** Gantt calendar row: Apr, May, … */
const ganttCalendarMonthShort = new Intl.DateTimeFormat('en-US', { month: 'short' })

function getStatusClass(status: TaskStatus): string {
  if (status === 'Finished') return 'status-finished'
  if (status === 'On process') return 'status-process'
  return 'status-not-started'
}

function getRoleClass(role: string): string {
  const normalized = role.trim().toLowerCase()
  if (!normalized) return 'role-empty'
  if (normalized === 'customer') return 'role-customer'
  if (normalized === 'internal') return 'role-internal'
  return 'role-generic'
}

function statusFromProgress(progress: number): TaskStatus {
  if (progress <= 0) return 'Not Started'
  if (progress >= 100) return 'Finished'
  return 'On process'
}

function normalizeRole(role: unknown): string {
  if (typeof role !== 'string') return ''
  const trimmed = role.trim()
  return trimmed
}

function getRoleStyle(role: string): CSSProperties | undefined {
  const normalized = role.trim().toLowerCase()
  if (!normalized || normalized === 'customer' || normalized === 'internal') return undefined

  let hash = 0
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) % 360
  }

  return {
    backgroundColor: `hsl(${hash} 70% 92%)`,
    color: `hsl(${hash} 48% 28%)`,
    borderColor: `hsl(${hash} 45% 68%)`,
  }
}

function formatShortDate(value: string): string {
  const t = parseTaskDate(value)
  if (t === null) return '-'
  return plannedEndFormatter.format(new Date(t))
}

/** First numeric value in free-text MH/MD (e.g. `8 MD`, `8.5 Man-hours`). */
function parseMhMdNumeric(value: string): number {
  const m = String(value ?? '').trim().match(/(\d+(?:\.\d+)?)/)
  if (!m) return 0
  const n = Number(m[1])
  return Number.isFinite(n) ? n : 0
}

/** `MH` / `MD` / unknown from free-text (used for parent rollup suffix). */
function unitFromDisplayMhMd(s: string): 'MH' | 'MD' | null {
  const t = String(s ?? '').trim()
  if (!t) return null
  if (/\bMH\b/i.test(t) || /man-?hours?/i.test(t)) return 'MH'
  if (/\bMD\b/i.test(t)) return 'MD'
  return null
}

/** If any child shows MH, parent rollup uses MH; else MD when any child shows MD; else MD. */
function rollupMhMdUnit(effectiveChildren: Task[]): 'MH' | 'MD' {
  if (effectiveChildren.some((c) => unitFromDisplayMhMd(c.mh_md ?? '') === 'MH')) return 'MH'
  if (effectiveChildren.some((c) => unitFromDisplayMhMd(c.mh_md ?? '') === 'MD')) return 'MD'
  return 'MD'
}

/** Display string for parent rollup from summed child values. */
function formatMhMdRollup(total: number, unit: 'MH' | 'MD'): string {
  if (total <= 0) return ''
  const suffix = unit === 'MH' ? 'MH' : 'MD'
  if (Number.isInteger(total)) return `${total} ${suffix}`
  const rounded = Math.round(total * 10) / 10
  return Number.isInteger(rounded) ? `${rounded} ${suffix}` : `${rounded.toFixed(1)} ${suffix}`
}

function getPlannedEndBadgeClass(value: string): string {
  const parsed = parseTaskDate(value)
  if (parsed === null) return 'planned-end-unknown'
  const target = toStartOfDay(parsed)
  const today = toStartOfDay(Date.now())
  if (target > today) return 'planned-end-future'
  if (target === today) return 'planned-end-today'
  return 'planned-end-past'
}

const toStartOfDay = (value: number) => {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const toStartOfMonth = (value: number) => {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

const addMonths = (value: number, diff: number) => {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth() + diff, 1).getTime()
}

const getWeekStart = (value: number) => {
  const date = new Date(value)
  const day = date.getDay()
  const diff = day === 0 ? -6 : 1 - day
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + diff).getTime()
}

const mountSnapshot = emptyDefaultSnapshot()

function parseTasksJson(saved: string | null): Task[] {
  if (!saved) return initialTasks.map((task) => ({ ...task }))

  try {
    const parsed = JSON.parse(saved) as Array<Partial<Task>>
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((task, index) => ({
        id: Number(task.id ?? index + 1),
        name: String(task.name ?? '新規タスク'),
        parent_id: task.parent_id ?? null,
        order: Number(task.order ?? index + 1),
        planned_start_date: String(
          (task as Task & { start_date?: string }).planned_start_date ??
            (task as Task & { start_date?: string }).start_date ??
            '2026-06-01',
        ),
        planned_end_date: String(
          (task as Task & { end_date?: string }).planned_end_date ??
            (task as Task & { end_date?: string }).end_date ??
            '2026-06-05',
        ),
        actual_start_date: String((task as Partial<Task>).actual_start_date ?? ''),
        actual_end_date: String((task as Partial<Task>).actual_end_date ?? ''),
        role: normalizeRole(task.role),
        status:
          task.status === 'Finished' || task.status === 'On process' || task.status === 'Not Started'
            ? task.status
            : 'Not Started',
        progress: Number(task.progress ?? 0),
        mh_md: String((task as Partial<Task>).mh_md ?? ''),
      }))
    }
  } catch {
    return initialTasks.map((task) => ({ ...task }))
  }

  return initialTasks.map((task) => ({ ...task }))
}

function App() {
  const wbsDbRef = useRef<WbsDbApi | null>(null)
  const [dbReady, setDbReady] = useState(false)

  const [projectName, setProjectName] = useState<string>(mountSnapshot.selectedProjectName)
  const [projectNameInput, setProjectNameInput] = useState<string>(mountSnapshot.selectedProjectName)
  const [companyFilter, setCompanyFilter] = useState('')
  /** 会社未設定のプロジェクトで Company Add 後のみ、会社 Rename を編集可能にする */
  const [companyUnlockPending, setCompanyUnlockPending] = useState(false)
  const [companyRenameInput, setCompanyRenameInput] = useState(
    () => mountSnapshot.projects[mountSnapshot.selectedProjectName]?.company ?? '',
  )
  const [projects, setProjects] = useState<Record<string, ProjectBundle>>(mountSnapshot.projects)
  const [tasks, setTasks] = useState<Task[]>([])
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const [selectedTaskId, setSelectedTaskId] = useState<number>(0)
  const [draggedTaskId, setDraggedTaskId] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<{ targetId: number; mode: 'before' | 'inside' | 'after' } | null>(
    null,
  )
  const wbsScrollRef = useRef<HTMLDivElement | null>(null)
  const ganttScrollRef = useRef<HTMLDivElement | null>(null)
  const syncingScrollRef = useRef(false)
  const tasksBelongToProjectRef = useRef(mountSnapshot.selectedProjectName)
  const [wbsScrollLeft, setWbsScrollLeft] = useState(0)
  const [wbsScrollMax, setWbsScrollMax] = useState(0)
  const [ganttScrollLeft, setGanttScrollLeft] = useState(0)
  const [ganttScrollMax, setGanttScrollMax] = useState(0)
  const [zoom, setZoom] = useState<ZoomUnit>(() => {
    try {
      const savedZoom = localStorage.getItem(ZOOM_STORAGE_KEY)
      if (savedZoom === 'day' || savedZoom === 'week' || savedZoom === 'month') {
        return savedZoom
      }
    } catch {
      /* ignore */
    }
    return mountSnapshot.zoom
  })

  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const projectNameRef = useRef(projectName)
  projectNameRef.current = projectName
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  const updateTasks = (updater: (current: Task[]) => Task[]) => {
    setTasks((current) => {
      const next = updater(current)
      if (JSON.stringify(next) === JSON.stringify(current)) return current
      return next
    })
  }

  useEffect(() => {
    if (!projectName) return
    if (tasksBelongToProjectRef.current !== projectName) return
    const normalized = tasksRef.current.map((task) => ({ ...task }))
    setProjects((current) => {
      const bundle = current[projectName] ?? emptyProjectBundle()
      if (JSON.stringify(bundle.tasks) === JSON.stringify(normalized)) return current
      return { ...current, [projectName]: { ...bundle, tasks: normalized } }
    })
  }, [projectName, tasks])

  useEffect(() => {
    const ac = new AbortController()
    let cancelled = false
    ;(async () => {
      try {
        const api = await openWbsSqlite(parseTasksJson, ac.signal)
        if (cancelled) return
        wbsDbRef.current = api
        const snap = api.readSnapshot()
        setProjectName(snap.selectedProjectName)
        setProjectNameInput(snap.selectedProjectName)
        setProjects(snap.projects)
        const bundle =
          snap.selectedProjectName && snap.projects[snap.selectedProjectName]
            ? snap.projects[snap.selectedProjectName]
            : null
        setCompanyRenameInput(bundle?.company ?? '')
        if (bundle?.tasks?.length) {
          setTasks(bundle.tasks.map((task) => ({ ...task })))
          setSelectedTaskId(bundle.tasks[0].id)
        } else {
          setTasks([])
          setSelectedTaskId(0)
        }
        tasksBelongToProjectRef.current = snap.selectedProjectName
        setZoom(snap.zoom)
      } catch (err) {
        console.error('SQLite init failed', err)
      } finally {
        if (!cancelled) setDbReady(true)
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  useEffect(() => {
    if (!dbReady || !wbsDbRef.current) return
    const handle = setTimeout(() => {
      void wbsDbRef.current!.persistSnapshot({
        selectedProjectName: projectNameRef.current,
        projects: projectsRef.current,
        zoom: zoomRef.current,
      }).catch((err) => console.error('[wbs] persistSnapshot failed', err))
    }, 150)
    return () => clearTimeout(handle)
  }, [dbReady, projectName, projects, zoom])

  useEffect(() => {
    if (!dbReady) return
    const flush = () => {
      const api = wbsDbRef.current
      if (!api) return
      void api
        .persistSnapshot({
          selectedProjectName: projectNameRef.current,
          projects: projectsRef.current,
          zoom: zoomRef.current,
        })
        .catch((err) => console.error('[wbs] persist flush failed', err))
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
    }
  }, [dbReady])

  useEffect(() => {
    localStorage.setItem(ZOOM_STORAGE_KEY, zoom)
  }, [zoom])

  useEffect(() => {
    setProjectNameInput(projectName)
  }, [projectName])

  useEffect(() => {
    if (!projectName) {
      setCompanyRenameInput('')
      setCompanyUnlockPending(false)
      return
    }
    const committed = (projects[projectName]?.company ?? '').trim()
    if (companyUnlockPending && !committed) return
    setCompanyRenameInput(projects[projectName]?.company ?? '')
  }, [projectName, projects[projectName]?.company, companyUnlockPending])

  useEffect(() => {
    if (!projectName) {
      setTasks([])
      tasksBelongToProjectRef.current = ''
      return
    }
    const currentProjectTasks = projects[projectName]?.tasks
    if (!currentProjectTasks || currentProjectTasks.length === 0) return
    setTasks(currentProjectTasks.map((task) => ({ ...task })))
    setSelectedTaskId(currentProjectTasks[0].id)
    tasksBelongToProjectRef.current = projectName
  }, [projectName])

  useEffect(() => {
    if (!tasks.some((task) => task.id === selectedTaskId) && tasks[0]) {
      setSelectedTaskId(tasks[0].id)
    }
  }, [selectedTaskId, tasks])

  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => a.order - b.order || a.id - b.id),
    [tasks],
  )

  const taskRows = useMemo(() => {
    const childrenMap = new Map<number | null, Task[]>()
    for (const task of sortedTasks) {
      const key = task.parent_id
      const existing = childrenMap.get(key) ?? []
      existing.push(task)
      childrenMap.set(key, existing)
    }

    const rows: Array<{ task: Task; depth: number }> = []
    const walk = (parentId: number | null, depth: number) => {
      const children = childrenMap.get(parentId) ?? []
      for (const task of children) {
        rows.push({ task, depth })
        walk(task.id, depth + 1)
      }
    }

    walk(null, 0)
    return rows
  }, [sortedTasks])

  const childrenMap = useMemo(() => {
    const map = new Map<number | null, Task[]>()
    for (const task of sortedTasks) {
      const key = task.parent_id
      const children = map.get(key) ?? []
      children.push(task)
      map.set(key, children)
    }
    return map
  }, [sortedTasks])

  const effectiveTaskMap = useMemo(() => {
    const base = new Map(tasks.map((task) => [task.id, task]))
    const result = new Map<number, Task>()

    const aggregate = (task: Task): Task => {
      const children = childrenMap.get(task.id) ?? []
      if (children.length === 0) {
        const leafTask = { ...task, status: statusFromProgress(task.progress) }
        result.set(task.id, leafTask)
        return leafTask
      }

      const effectiveChildren = children.map((child) => aggregate(child))
      const average = Math.round(
        effectiveChildren.reduce((sum, child) => sum + child.progress, 0) / effectiveChildren.length,
      )
      const hasProcess = effectiveChildren.some((child) => child.status === 'On process')
      const hasNotStarted = effectiveChildren.some((child) => child.status === 'Not Started')
      const status: TaskStatus = average >= 100 ? 'Finished' : hasProcess || !hasNotStarted ? 'On process' : 'Not Started'
      const sumMhMd = effectiveChildren.reduce((sum, child) => sum + parseMhMdNumeric(child.mh_md ?? ''), 0)
      const mhMdUnit = rollupMhMdUnit(effectiveChildren)

      const aggregated: Task = {
        ...task,
        progress: average,
        status,
        mh_md: formatMhMdRollup(sumMhMd, mhMdUnit),
        // Keep parent schedule as the source of truth.
        // Only progress, status, and MH/MD rollup are auto-aggregated from children.
        planned_start_date: task.planned_start_date,
        planned_end_date: task.planned_end_date,
      }
      result.set(task.id, aggregated)
      return aggregated
    }

    for (const task of tasks) {
      if (!base.has(task.id)) continue
      if (!result.has(task.id)) aggregate(task)
    }

    return result
  }, [childrenMap, tasks])

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0]
  const hasChildren = selectedTask ? (childrenMap.get(selectedTask.id) ?? []).length > 0 : false
  const selectedComputedStatus = selectedTask
    ? hasChildren
      ? (effectiveTaskMap.get(selectedTask.id) ?? selectedTask).status
      : statusFromProgress(selectedTask.progress)
    : 'Not Started'

  const wbsTreeHeaderCaption = useMemo(() => {
    if (!projectName) return 'プロジェクトを選択してください'
    const b = projects[projectName]
    const company = (b?.company ?? '').trim()
    const poLabel = formatPoDateForHeader(b?.po_date ?? '')
    const parts = [projectName]
    if (company) parts.push(company)
    if (poLabel) parts.push(poLabel)
    return parts.join(' | ')
  }, [projectName, projects])

  /** 全プロジェクトに登場する会社名（絞り込み用）。 */
  const distinctCompaniesForFilter = useMemo(() => {
    const names = new Set<string>()
    for (const bundle of Object.values(projects)) {
      const c = (bundle.company ?? '').trim()
      if (c) names.add(c)
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b))
  }, [projects])

  const allProjectNames = useMemo(
    () => Object.keys(projects).sort((a, b) => a.localeCompare(b)),
    [projects],
  )

  /** 会社で絞り込んだうえでの Project 一覧（未指定なら全件）。選択中のみフィルター外でも一覧に残す。 */
  const filteredProjectNames = useMemo(() => {
    const cf = companyFilter.trim()
    const base = !cf
      ? [...allProjectNames]
      : allProjectNames.filter((name) => (projects[name]?.company ?? '').trim() === cf)
    if (projectName && projects[projectName] && !base.includes(projectName)) {
      base.push(projectName)
      base.sort((a, b) => a.localeCompare(b))
    }
    return base
  }, [allProjectNames, companyFilter, projects, projectName])

  useLayoutEffect(() => {
    if (!projectName) return
    if (!filteredProjectNames.includes(projectName)) {
      setProjectName(filteredProjectNames[0] ?? '')
    }
  }, [projectName, filteredProjectNames])

  const canLevelUp = Boolean(selectedTask && selectedTask.parent_id !== null)

  const canLevelDown = useMemo(() => {
    const st = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0]
    if (!st) return false
    const siblings = tasks
      .filter((task) => task.parent_id === st.parent_id)
      .sort((a, b) => a.order - b.order || a.id - b.id)
    return siblings.findIndex((task) => task.id === st.id) > 0
  }, [selectedTaskId, tasks])

  const [minStart, maxEnd] = useMemo(() => {
    if (!tasks.length) {
      const t = toStartOfDay(Date.now())
      return [t, t + DAY_MS]
    }
    const effectiveTasks = tasks.map((task) => effectiveTaskMap.get(task.id) ?? task)
    const starts = effectiveTasks
      .flatMap((task) => [task.planned_start_date, task.actual_start_date])
      .map(parseTaskDate)
      .filter((t): t is number => t !== null)
    const ends = effectiveTasks
      .flatMap((task) => [task.planned_end_date, task.actual_end_date])
      .map(parseTaskDate)
      .filter((t): t is number => t !== null)
    if (!starts.length || !ends.length) {
      const t = toStartOfDay(Date.now())
      return [t, t + DAY_MS]
    }
    return [Math.min(...starts), Math.max(...ends)]
  }, [effectiveTaskMap, tasks])

  const timelineMeta = useMemo(() => {
    const { unitWidth, minWidth } = ZOOM_CONFIG[zoom]

    if (zoom === 'day') {
      const axisStart = toStartOfDay(minStart)
      const axisEnd = toStartOfDay(maxEnd)
      const totalUnits = Math.max(1, Math.ceil((axisEnd - axisStart) / DAY_MS) + 1)
      return { axisStart, totalUnits, unitWidth, minWidth }
    }

    if (zoom === 'week') {
      const axisStart = getWeekStart(minStart)
      const axisEnd = getWeekStart(maxEnd)
      const totalUnits = Math.max(1, Math.ceil((axisEnd - axisStart) / (7 * DAY_MS)) + 1)
      return { axisStart, totalUnits, unitWidth, minWidth }
    }

    const axisStart = toStartOfMonth(minStart)
    const endMonthStart = toStartOfMonth(maxEnd)
    const startDate = new Date(axisStart)
    const endDate = new Date(endMonthStart)
    const months = (endDate.getFullYear() - startDate.getFullYear()) * 12 + (endDate.getMonth() - startDate.getMonth())
    const totalUnits = Math.max(1, months + 1)
    return { axisStart, totalUnits, unitWidth, minWidth }
  }, [maxEnd, minStart, zoom])

  /** Pixel width of the date grid only (bars must use this, not minWidth stretch). */
  const timelineContentWidth = timelineMeta.totalUnits * timelineMeta.unitWidth

  useEffect(() => {
    const syncScrollMeta = () => {
      const wbsEl = wbsScrollRef.current
      const ganttEl = ganttScrollRef.current
      if (wbsEl) {
        setWbsScrollLeft(wbsEl.scrollLeft)
        setWbsScrollMax(Math.max(0, wbsEl.scrollWidth - wbsEl.clientWidth))
      }
      if (ganttEl) {
        setGanttScrollLeft(ganttEl.scrollLeft)
        setGanttScrollMax(Math.max(0, ganttEl.scrollWidth - ganttEl.clientWidth))
      }
    }

    const rafId = requestAnimationFrame(syncScrollMeta)
    window.addEventListener('resize', syncScrollMeta)
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', syncScrollMeta)
    }
  }, [tasks, zoom, timelineContentWidth])

  const timelineTicks = useMemo(() => {
    if (zoom === 'day') {
      return Array.from({ length: timelineMeta.totalUnits }, (_, index) => {
        const date = new Date(timelineMeta.axisStart + index * DAY_MS)
        const dow = date.getDay()
        return {
          key: date.toISOString().slice(0, 10),
          top: date.getDate() === 1 || index === 0 ? ganttCalendarMonthShort.format(date) : '',
          bottom: `${date.getDate()}`,
          isWeekend: dow === 0 || dow === 6,
        }
      })
    }
    if (zoom === 'week') {
      return Array.from({ length: timelineMeta.totalUnits }, (_, index) => {
        const start = new Date(timelineMeta.axisStart + index * 7 * DAY_MS)
        const prevStart = index > 0 ? new Date(timelineMeta.axisStart + (index - 1) * 7 * DAY_MS) : null
        const isMonthStartWeek = index === 0 || (prevStart && prevStart.getMonth() !== start.getMonth())
        return {
          key: `${start.toISOString().slice(0, 10)}-w`,
          top: isMonthStartWeek ? ganttCalendarMonthShort.format(start) : '',
          bottom: `W${index + 1}`,
          isWeekend: false,
        }
      })
    }
    return Array.from({ length: timelineMeta.totalUnits }, (_, index) => {
      const date = new Date(addMonths(timelineMeta.axisStart, index))
      return {
        key: `${date.getFullYear()}-${date.getMonth() + 1}`,
        top: `${date.getFullYear()}`,
        bottom: ganttCalendarMonthShort.format(date),
        isWeekend: false,
      }
    })
  }, [timelineMeta.axisStart, timelineMeta.totalUnits, zoom])

  const updateTask = <K extends keyof Task>(taskId: number, key: K, value: Task[K]) => {
    updateTasks((current) => {
      const parentIds = new Set(current.filter((task) => task.parent_id !== null).map((task) => task.parent_id as number))

      return current.map((task) => {
        if (task.id !== taskId) return task
        const updated = { ...task, [key]: value }
        if (parentIds.has(taskId)) return updated
        return { ...updated, status: statusFromProgress(updated.progress) }
      })
    })
  }

  const moveTask = (taskId: number, direction: 'up' | 'down') => {
    updateTasks((current) => {
      const target = current.find((task) => task.id === taskId)
      if (!target) return current

      const siblings = current
        .filter((task) => task.parent_id === target.parent_id)
        .sort((a, b) => a.order - b.order || a.id - b.id)
      const index = siblings.findIndex((task) => task.id === taskId)
      const swapIndex = direction === 'up' ? index - 1 : index + 1
      if (index < 0 || swapIndex < 0 || swapIndex >= siblings.length) return current

      const sibling = siblings[swapIndex]
      return current.map((task) => {
        if (task.id === target.id) return { ...task, order: sibling.order }
        if (task.id === sibling.id) return { ...task, order: target.order }
        return task
      })
    })
  }

  const normalizeOrders = (items: Task[]) => {
    const grouped = new Map<number | null, Task[]>()
    for (const task of items) {
      const bucket = grouped.get(task.parent_id) ?? []
      bucket.push(task)
      grouped.set(task.parent_id, bucket)
    }

    const normalized: Task[] = []
    for (const [, group] of grouped) {
      group
        .sort((a, b) => a.order - b.order || a.id - b.id)
        .forEach((task, index) => normalized.push({ ...task, order: index + 1 }))
    }
    return normalized
  }

  const isDescendant = (candidateParentId: number | null, taskId: number, source: Task[]) => {
    if (candidateParentId === null) return false
    let cursor: number | null = candidateParentId
    while (cursor !== null) {
      if (cursor === taskId) return true
      cursor = source.find((task) => task.id === cursor)?.parent_id ?? null
    }
    return false
  }

  const levelUp = (taskId: number) => {
    updateTasks((current) => {
      const source = current.map((task) => ({ ...task }))
      const t = source.find((task) => task.id === taskId)
      if (!t || t.parent_id === null) return current

      const parent = source.find((task) => task.id === t.parent_id)
      if (!parent) return current

      const grandParentId = parent.parent_id
      if (isDescendant(grandParentId, taskId, source)) return current

      t.parent_id = grandParentId

      const siblingsWithoutT = source
        .filter((task) => task.parent_id === grandParentId && task.id !== taskId)
        .sort((a, b) => a.order - b.order || a.id - b.id)

      const parentIndex = siblingsWithoutT.findIndex((task) => task.id === parent.id)
      const insertAt = parentIndex >= 0 ? parentIndex + 1 : siblingsWithoutT.length
      const orderedIds = [
        ...siblingsWithoutT.slice(0, insertAt).map((task) => task.id),
        taskId,
        ...siblingsWithoutT.slice(insertAt).map((task) => task.id),
      ]

      for (const task of source) {
        if (task.parent_id !== grandParentId) continue
        const pos = orderedIds.indexOf(task.id)
        if (pos >= 0) task.order = pos + 1
      }

      return normalizeOrders(source)
    })
  }

  const levelDown = (taskId: number) => {
    updateTasks((current) => {
      const source = current.map((task) => ({ ...task }))
      const t = source.find((task) => task.id === taskId)
      if (!t) return current

      const siblings = source
        .filter((task) => task.parent_id === t.parent_id)
        .sort((a, b) => a.order - b.order || a.id - b.id)
      const index = siblings.findIndex((task) => task.id === taskId)
      if (index <= 0) return current

      const prevSibling = siblings[index - 1]
      if (isDescendant(prevSibling.id, taskId, source)) return current

      const childrenOfPrev = source.filter((task) => task.parent_id === prevSibling.id && task.id !== taskId)
      const maxOrder = childrenOfPrev.length ? Math.max(...childrenOfPrev.map((c) => c.order)) : 0

      t.parent_id = prevSibling.id
      t.order = maxOrder + 1

      return normalizeOrders(source)
    })
  }

  const moveTaskByDnD = (fromId: number, targetId: number, mode: 'before' | 'inside' | 'after') => {
    if (fromId === targetId) return

    updateTasks((current) => {
      const source = current.map((task) => ({ ...task }))
      const dragged = source.find((task) => task.id === fromId)
      const target = source.find((task) => task.id === targetId)
      if (!dragged || !target) return current

      const newParentId = mode === 'inside' ? target.id : target.parent_id
      if (isDescendant(newParentId, fromId, source)) return current

      dragged.parent_id = newParentId

      const siblings = source
        .filter((task) => task.parent_id === newParentId && task.id !== fromId)
        .sort((a, b) => a.order - b.order || a.id - b.id)

      if (mode === 'inside') {
        siblings.push(dragged)
      } else {
        const targetIndex = siblings.findIndex((task) => task.id === target.id)
        const insertIndex = mode === 'before' ? targetIndex : targetIndex + 1
        siblings.splice(Math.max(0, insertIndex), 0, dragged)
      }

      for (let i = 0; i < siblings.length; i += 1) {
        siblings[i].order = i + 1
      }

      return normalizeOrders(source)
    })
  }

  const handleAutoScroll = (clientY: number) => {
    const container = wbsScrollRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const threshold = 44
    const speed = 18

    if (clientY < rect.top + threshold) {
      container.scrollTop -= speed
      syncVerticalScroll('left')
    } else if (clientY > rect.bottom - threshold) {
      container.scrollTop += speed
      syncVerticalScroll('left')
    }
  }

  const syncVerticalScroll = (source: 'left' | 'right') => {
    if (syncingScrollRef.current) return
    const left = wbsScrollRef.current
    const right = ganttScrollRef.current
    if (!left || !right) return

    syncingScrollRef.current = true
    if (source === 'left') {
      right.scrollTop = left.scrollTop
    } else {
      left.scrollTop = right.scrollTop
    }
    requestAnimationFrame(() => {
      syncingScrollRef.current = false
    })
  }

  const addTask = (parentId: number | null) => {
    updateTasks((current) => {
      const nextId = current.reduce((max, task) => Math.max(max, task.id), 0) + 1
      const siblingCount = current.filter((task) => task.parent_id === parentId).length
      const baseStart = selectedTask?.planned_start_date ?? '2026-06-01'
      const baseEnd = selectedTask?.planned_end_date ?? '2026-06-05'
      const newTask: Task = {
        id: nextId,
        name: '新規タスク',
        parent_id: parentId,
        order: siblingCount + 1,
        planned_start_date: baseStart,
        planned_end_date: baseEnd,
        actual_start_date: '',
        actual_end_date: '',
        role: 'Internal',
        status: 'Not Started',
        progress: 0,
        mh_md: '',
      }
      const next = [...current, newTask]
      setSelectedTaskId(nextId)
      return next
    })
  }

  const createProject = () => {
    let count = 1
    let nextName = 'New Project'
    while (projects[nextName]) {
      count += 1
      nextName = `New Project ${count}`
    }
    const fresh = NEW_PROJECT_DEFAULT_TASKS.map((task) => ({ ...task }))
    const nextProjects: Record<string, ProjectBundle> = {
      ...projects,
      [nextName]: emptyProjectBundle(fresh),
    }
    setCompanyUnlockPending(false)
    tasksBelongToProjectRef.current = nextName
    setProjects(nextProjects)
    setProjectName(nextName)
    setProjectNameInput(nextName)
    setTasks(fresh)
    setSelectedTaskId(fresh[0].id)
    setCompanyRenameInput('')
    projectsRef.current = nextProjects
    projectNameRef.current = nextName
    if (wbsDbRef.current) {
      void wbsDbRef.current
        .persistSnapshot({
          selectedProjectName: nextName,
          projects: nextProjects,
          zoom: zoomRef.current,
        })
        .catch((err) => console.error('[wbs] persist after createProject failed', err))
    }
  }

  const updateCompany = (company: string) => {
    if (!projectName) return
    setProjects((current) => {
      const bundle =
        current[projectName] ?? emptyProjectBundle(tasksRef.current.map((task) => ({ ...task })))
      if (bundle.company === company) return current
      return { ...current, [projectName]: { ...bundle, company } }
    })
  }

  const updateProjectPoDate = (poDate: string) => {
    if (!projectName) return
    setProjects((current) => {
      const bundle =
        current[projectName] ?? emptyProjectBundle(tasksRef.current.map((task) => ({ ...task })))
      if ((bundle.po_date ?? '') === poDate) return current
      return { ...current, [projectName]: { ...bundle, po_date: poDate } }
    })
  }

  const applyCompanyRenameField = () => {
    if (!projectName) return
    const committed = (projects[projectName]?.company ?? '').trim()
    const draft = companyRenameInput.trim()

    if (companyUnlockPending && !committed) {
      if (!draft) {
        setCompanyUnlockPending(false)
        setCompanyRenameInput('')
        return
      }
      updateCompany(draft)
      setCompanyFilter(draft)
      setCompanyUnlockPending(false)
      setCompanyRenameInput(draft)
      return
    }

    if (draft === committed) {
      setCompanyRenameInput(projects[projectName]?.company ?? '')
      return
    }
    updateCompany(draft)
    setCompanyRenameInput(draft)
  }

  const addCompanyForProject = () => {
    if (!projectName) return
    if ((projects[projectName]?.company ?? '').trim()) return
    const taken = new Set<string>()
    for (const b of Object.values(projects)) {
      const c = (b.company ?? '').trim()
      if (c) taken.add(c)
    }
    let n = 1
    let name = 'New Company'
    while (taken.has(name)) {
      n += 1
      name = `New Company ${n}`
    }
    setCompanyUnlockPending(true)
    setCompanyRenameInput(name)
  }

  const deleteCompanyForProject = () => {
    if (!projectName) return
    setCompanyUnlockPending(false)
    updateCompany('')
    setCompanyRenameInput('')
  }

  const applyProjectNameField = () => {
    if (!projectName) {
      setProjectNameInput(projectName)
      return
    }
    const trimmed = projectNameInput.trim()
    if (!trimmed) {
      setProjectNameInput(projectName)
      return
    }

    if (trimmed === projectName) {
      setProjectNameInput(projectName)
      return
    }

    if (Object.prototype.hasOwnProperty.call(projects, trimmed)) {
      setProjectName(trimmed)
      return
    }

    const bundle =
      projects[projectName] ?? emptyProjectBundle(tasksRef.current.map((task) => ({ ...task })))
    const next: Record<string, ProjectBundle> = { ...projects }
    delete next[projectName]
    next[trimmed] = {
      tasks: bundle.tasks.map((task) => ({ ...task })),
      company: bundle.company,
      po_date: bundle.po_date ?? '',
    }
    tasksBelongToProjectRef.current = trimmed
    setProjects(next)
    setProjectName(trimmed)
    projectsRef.current = next
    projectNameRef.current = trimmed
    if (wbsDbRef.current) {
      void wbsDbRef.current
        .persistSnapshot({
          selectedProjectName: trimmed,
          projects: next,
          zoom: zoomRef.current,
        })
        .catch((err) => console.error('[wbs] persist after project rename failed', err))
    }
  }

  const deleteProject = () => {
    if (!projectName || !projects[projectName]) return
    const names = Object.keys(projects)
    const nextProjects = { ...projects }
    delete nextProjects[projectName]
    const nextName = names.find((name) => name !== projectName) ?? ''
    setCompanyUnlockPending(false)
    setProjects(nextProjects)
    setProjectName(nextName)
    projectsRef.current = nextProjects
    projectNameRef.current = nextName
    if (wbsDbRef.current) {
      void wbsDbRef.current
        .persistSnapshot({
          selectedProjectName: nextName,
          projects: nextProjects,
          zoom: zoomRef.current,
        })
        .catch((err) => console.error('[wbs] persist after deleteProject failed', err))
    }
  }

  const removeTask = (taskId: number) => {
    updateTasks((current) => {
      const idsToDelete = new Set<number>()
      const walk = (id: number) => {
        idsToDelete.add(id)
        for (const child of current.filter((task) => task.parent_id === id)) {
          walk(child.id)
        }
      }
      walk(taskId)
      return current.filter((task) => !idsToDelete.has(task.id))
    })
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isFormInput =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
      if (isFormInput) return
      if (!selectedTask) return

      if (event.altKey && event.key === 'ArrowUp') {
        event.preventDefault()
        moveTask(selectedTask.id, 'up')
      } else if (event.altKey && event.key === 'ArrowDown') {
        event.preventDefault()
        moveTask(selectedTask.id, 'down')
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        addTask(selectedTask.parent_id)
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        addTask(selectedTask.id)
      } else if (event.key === 'Delete') {
        event.preventDefault()
        if (tasks.length > 1) removeTask(selectedTask.id)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedTask, tasks.length])

  const getBarStyle = (startDate: string, endDate: string) => {
    const startTime = parseTaskDate(startDate)
    const endTime = parseTaskDate(endDate)
    if (startTime === null || endTime === null) return null

    let startOffset = 0
    let duration = 1

    if (zoom === 'day') {
      startOffset = Math.max(0, Math.floor((toStartOfDay(startTime) - timelineMeta.axisStart) / DAY_MS))
      duration = Math.max(1, Math.ceil((toStartOfDay(endTime) - toStartOfDay(startTime)) / DAY_MS) + 1)
    } else if (zoom === 'week') {
      startOffset = Math.max(0, Math.floor((getWeekStart(startTime) - timelineMeta.axisStart) / (7 * DAY_MS)))
      duration = Math.max(1, Math.ceil((toStartOfDay(endTime) - getWeekStart(startTime)) / (7 * DAY_MS)) + 1)
    } else {
      const startMonth = toStartOfMonth(startTime)
      const endMonth = toStartOfMonth(endTime)
      const axisDate = new Date(timelineMeta.axisStart)
      const startDate = new Date(startMonth)
      const endDate = new Date(endMonth)
      startOffset =
        (startDate.getFullYear() - axisDate.getFullYear()) * 12 + (startDate.getMonth() - axisDate.getMonth())
      duration =
        (endDate.getFullYear() - startDate.getFullYear()) * 12 + (endDate.getMonth() - startDate.getMonth()) + 1
      startOffset = Math.max(0, startOffset)
      duration = Math.max(1, duration)
    }

    const uw = timelineMeta.unitWidth
    return {
      left: `${startOffset * uw}px`,
      width: `${duration * uw}px`,
    }
  }

  const exportExcel = async () => {
    if (!projectName || !tasks.length) return
    const wbsRows = taskRows.map(({ task, depth }) => {
      const effectiveTask = effectiveTaskMap.get(task.id) ?? task
      return {
        ID: task.id,
        Task: task.name,
        Level: depth + 1,
        Role: effectiveTask.role,
        'MH/MD': effectiveTask.mh_md ?? '',
        'Planned Start': effectiveTask.planned_start_date,
        'Planned End': effectiveTask.planned_end_date,
        'Actual Start': effectiveTask.actual_start_date,
        'Actual End': effectiveTask.actual_end_date,
        Status: effectiveTask.status,
        Progress: `${effectiveTask.progress}%`,
      }
    })

    const unitBounds = Array.from({ length: timelineMeta.totalUnits }, (_, index) => {
      if (zoom === 'day') {
        const start = toStartOfDay(timelineMeta.axisStart + index * DAY_MS)
        return { start, end: start + DAY_MS - 1 }
      }
      if (zoom === 'week') {
        const start = timelineMeta.axisStart + index * 7 * DAY_MS
        return { start, end: start + 7 * DAY_MS - 1 }
      }
      const start = addMonths(timelineMeta.axisStart, index)
      return { start, end: addMonths(timelineMeta.axisStart, index + 1) - 1 }
    })

    const ganttAoA: Array<Array<string>> = [
      ['Task', ...timelineTicks.map((tick) => tick.top)],
      ['', ...timelineTicks.map((tick) => tick.bottom)],
    ]
    const actualFillFlags: boolean[][] = []

    for (const { task } of taskRows) {
      const effectiveTask = effectiveTaskMap.get(task.id) ?? task
      const plannedStartParsed = parseTaskDate(effectiveTask.planned_start_date)
      const plannedEndParsed = parseTaskDate(effectiveTask.planned_end_date)
      const plannedStart =
        plannedStartParsed !== null ? toStartOfDay(plannedStartParsed) : null
      const plannedEnd =
        plannedEndParsed !== null ? toStartOfDay(plannedEndParsed) + DAY_MS - 1 : null
      const actualStartParsed = parseTaskDate(effectiveTask.actual_start_date)
      const actualEndParsed = parseTaskDate(effectiveTask.actual_end_date)
      const actualStart = actualStartParsed !== null ? toStartOfDay(actualStartParsed) : null
      const actualEnd =
        actualEndParsed !== null
          ? toStartOfDay(actualEndParsed) + DAY_MS - 1
          : toStartOfDay(Date.now()) + DAY_MS - 1

      const cells = unitBounds.map(({ start, end }) => {
        const inPlanned = plannedStart !== null && plannedEnd !== null && start <= plannedEnd && end >= plannedStart
        return inPlanned ? '@' : ''
      })
      const actualFlags = unitBounds.map(({ start, end }) => {
        if (actualStart === null) return false
        if (actualEnd < actualStart) return false
        return start <= actualEnd && end >= actualStart
      })

      ganttAoA.push([effectiveTask.name, ...cells])
      actualFillFlags.push(actualFlags)
    }

    const wbsHeaders = [
      'ID',
      'Task',
      'Level',
      'Role',
      'MH/MD',
      'Planned Start',
      'Planned End',
      'Actual Start',
      'Actual End',
      'Status',
      'Progress',
    ]

    const combinedAoA: Array<Array<string | number>> = []
    combinedAoA.push([...wbsHeaders, ...ganttAoA[0].slice(1)])
    combinedAoA.push([...new Array(wbsHeaders.length).fill(''), ...ganttAoA[1].slice(1)])

    for (let i = 0; i < wbsRows.length; i += 1) {
      const wbsRow = wbsRows[i]
      const ganttRow = ganttAoA[i + 2] ?? []
      combinedAoA.push([
        wbsRow.ID,
        wbsRow.Task,
        wbsRow.Level,
        wbsRow.Role,
        wbsRow['MH/MD'],
        wbsRow['Planned Start'],
        wbsRow['Planned End'],
        wbsRow['Actual Start'],
        wbsRow['Actual End'],
        wbsRow.Status,
        wbsRow.Progress,
        ...ganttRow.slice(1),
      ])
    }

    const ExcelJS = (await import('exceljs')).default
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('WBS_Gantt')

    combinedAoA.forEach((row) => sheet.addRow(row))

    const totalRows = combinedAoA.length
    const totalCols = Math.max(...combinedAoA.map((row) => row.length), 0)

    // Apply borders only to the actual table range.
    for (let r = 1; r <= totalRows; r += 1) {
      for (let c = 1; c <= totalCols; c += 1) {
        const cell = sheet.getCell(r, c)
        cell.font = { name: 'Meiryo UI', size: 10 }
        cell.alignment = { vertical: 'middle', horizontal: 'center' }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FF4B5563' } },
          left: { style: 'thin', color: { argb: 'FF4B5563' } },
          bottom: { style: 'thin', color: { argb: 'FF4B5563' } },
          right: { style: 'thin', color: { argb: 'FF4B5563' } },
        }

        // Fill actual period cells (blue) in Gantt area.
        const dataRowIndex = r - 3 // Row 3 is first task row.
        const ganttColOffset = c - (wbsHeaders.length + 1) // First gantt calendar column is after WBS columns.
        if (
          dataRowIndex >= 0 &&
          dataRowIndex < actualFillFlags.length &&
          ganttColOffset >= 0 &&
          ganttColOffset < timelineMeta.totalUnits &&
          actualFillFlags[dataRowIndex][ganttColOffset]
        ) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF93C5FD' },
          }
        }
      }
    }

    sheet.columns.forEach((column) => {
      column.width = 14
    })
    sheet.getColumn(2).width = 24

    const buffer = await workbook.xlsx.writeBuffer()
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'wbs-gantt-export.xlsx'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const hasCompanyOnProject = Boolean((projects[projectName]?.company ?? '').trim())
  const companyRenameDisabled = !projectName || (!hasCompanyOnProject && !companyUnlockPending)
  const companyAddDisabled = !projectName || hasCompanyOnProject
  const companyDeleteDisabled = !projectName || (!hasCompanyOnProject && !companyUnlockPending)

  if (!dbReady) {
    return (
      <main className="app" style={{ padding: 32, textAlign: 'center', fontWeight: 600 }}>
        データベースを読み込み中…
      </main>
    )
  }

  return (
    <main className="app">
      <header className="app-header">
        <div className="app-header-row">
          <img className="app-logo" src={logoImg} alt="WBS Viewer" />
          <button
            type="button"
            className="export-btn"
            onClick={() => void exportExcel()}
            disabled={!projectName || tasks.length === 0}
          >
            Export Excel
          </button>
        </div>
      </header>

      <section className="board">
        <div className="board-project-bar">
          <div className="editor-project-block">
            <div className="editor-project-fields">
              <div className="board-project-row board-project-row-single">
                <div className="board-project-cluster board-project-cluster-left">
                  <label className="board-project-col-name board-project-col-project">
                    <span className="editor-project-subfield-label">Project</span>
                    <select value={projectName} onChange={(event) => setProjectName(event.target.value)}>
                      <option value="">プロジェクトを選択…</option>
                      {filteredProjectNames.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="editor-project-rename board-project-col-rename board-project-col-rename-narrow">
                    <span className="editor-project-subfield-label">Rename</span>
                    <input
                      className="editor-project-subfield-input"
                      value={projectNameInput}
                      onChange={(event) => setProjectNameInput(event.target.value)}
                      onBlur={() => applyProjectNameField()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          applyProjectNameField()
                        }
                      }}
                      placeholder="New name (blur or Enter to apply)"
                      disabled={!projectName}
                    />
                  </label>
                  <div className="editor-project-actions editor-project-actions--inline board-project-col-actions">
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={createProject}
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={deleteProject}
                      disabled={!projectName}
                    >
                      Delete
                    </button>
                  </div>
                  <label className="board-project-col-po-date">
                    <span className="editor-project-subfield-label">PO Date</span>
                    <input
                      className="editor-project-subfield-input"
                      type="date"
                      value={projects[projectName]?.po_date ?? ''}
                      onChange={(event) => updateProjectPoDate(event.target.value)}
                      disabled={!projectName}
                    />
                  </label>
                </div>
                <div className="board-project-cluster board-project-cluster-right">
                  <label className="board-project-col-name board-project-col-company-select board-project-col-company-narrow">
                    <span className="editor-project-subfield-label">会社で絞り込み</span>
                    <select
                      value={companyFilter}
                      onChange={(event) => setCompanyFilter(event.target.value)}
                      aria-label="会社で絞り込み"
                    >
                      <option value="">ALL</option>
                      {distinctCompaniesForFilter.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="editor-project-rename board-project-col-rename board-project-col-company-narrow">
                    <span className="editor-project-subfield-label">このプロジェクトの会社</span>
                    <input
                      className="editor-project-subfield-input"
                      value={companyRenameInput}
                      onChange={(event) => setCompanyRenameInput(event.target.value)}
                      onBlur={applyCompanyRenameField}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          applyCompanyRenameField()
                        }
                      }}
                      placeholder="Set company for this project"
                      disabled={companyRenameDisabled}
                    />
                  </label>
                  <div className="editor-project-actions editor-project-actions--inline board-project-col-actions">
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={addCompanyForProject}
                      disabled={companyAddDisabled}
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={deleteCompanyForProject}
                      disabled={companyDeleteDisabled}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="board-panels">
        <div className="panel panel-left">
          <div className="wbs-header-row">
            <h2>WBS Tree</h2>
            <span className="wbs-current-project" title={wbsTreeHeaderCaption}>
              {wbsTreeHeaderCaption}
            </span>
          </div>
          <div
            className="wbs-scroll board-panel-scroll"
            ref={wbsScrollRef}
            onScroll={() => {
              const el = wbsScrollRef.current
              if (!el) return
              setWbsScrollLeft(el.scrollLeft)
              syncVerticalScroll('left')
            }}
          >
            <div className="wbs-inner">
              <div className="wbs-column-header">
                <span className="wbs-col-task">Task</span>
                <span className="wbs-col-role">Role</span>
                <span className="wbs-col-mh-md">MH/MD</span>
                <span className="wbs-col-date">Planned End</span>
                <span className="wbs-col-status">Status</span>
              </div>
              <div className="rows rows-scrollable wbs-rows-scrollable">
                {taskRows.map(({ task, depth }) => (
                  <button
                    key={task.id}
                    type="button"
                    title={task.name}
                    className={`row wbs-row ${selectedTaskId === task.id ? 'row-selected' : ''} ${draggedTaskId === task.id ? 'row-dragging' : ''}`}
                    onClick={() => setSelectedTaskId(task.id)}
                    draggable
                    onDragStart={() => {
                      setDraggedTaskId(task.id)
                    }}
                    onDragEnd={() => {
                      setDraggedTaskId(null)
                      setDragOver(null)
                    }}
                    onDragOver={(event) => {
                      if (draggedTaskId === null || draggedTaskId === task.id) return
                      event.preventDefault()
                      handleAutoScroll(event.clientY)
                      const rect = event.currentTarget.getBoundingClientRect()
                      const offsetY = event.clientY - rect.top
                      const mode =
                        offsetY < rect.height * 0.25 ? 'before' : offsetY > rect.height * 0.75 ? 'after' : 'inside'
                      setDragOver({ targetId: task.id, mode })
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (!draggedTaskId || draggedTaskId === task.id || !dragOver) return
                      moveTaskByDnD(draggedTaskId, task.id, dragOver.mode)
                      setDragOver(null)
                      setDraggedTaskId(null)
                    }}
                  >
                    {dragOver?.targetId === task.id && dragOver.mode === 'before' && <span className="drop-line drop-before" />}
                    <span className="task-name" style={{ paddingLeft: `${depth * 20 + 8}px` }}>
                      {task.name}
                    </span>
                    <span className="role-cell">
                      <span
                        className={`role-badge ${getRoleClass((effectiveTaskMap.get(task.id) ?? task).role)}`}
                        style={getRoleStyle((effectiveTaskMap.get(task.id) ?? task).role)}
                      >
                        {(effectiveTaskMap.get(task.id) ?? task).role}
                      </span>
                    </span>
                    <span className="mh-md-cell" title={(effectiveTaskMap.get(task.id) ?? task).mh_md ?? ''}>
                      {(effectiveTaskMap.get(task.id) ?? task).mh_md?.trim() || '—'}
                    </span>
                    <span className="planned-end-cell">
                      <span
                        className={`planned-end-badge ${getPlannedEndBadgeClass(
                          (effectiveTaskMap.get(task.id) ?? task).planned_end_date,
                        )}`}
                      >
                        {formatShortDate((effectiveTaskMap.get(task.id) ?? task).planned_end_date)}
                      </span>
                    </span>
                    {dragOver?.targetId === task.id && dragOver.mode === 'inside' && <span className="drop-inside">Make child</span>}
                    <span className="status-cell">
                      <span className={`status ${getStatusClass((effectiveTaskMap.get(task.id) ?? task).status)}`}>
                        {(effectiveTaskMap.get(task.id) ?? task).status}
                      </span>
                    </span>
                    {dragOver?.targetId === task.id && dragOver.mode === 'after' && <span className="drop-line drop-after" />}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <input
            className="h-scroll-control"
            type="range"
            min={0}
            max={Math.max(1, wbsScrollMax)}
            value={Math.min(wbsScrollLeft, Math.max(1, wbsScrollMax))}
            onChange={(event) => {
              const next = Number(event.target.value)
              setWbsScrollLeft(next)
              if (wbsScrollRef.current) wbsScrollRef.current.scrollLeft = next
            }}
            disabled={wbsScrollMax <= 0}
          />
          <p className="timeline-caption timeline-caption-placeholder">
            Period: {new Date(minStart).toLocaleDateString()} - {new Date(maxEnd).toLocaleDateString()}
          </p>
        </div>

        <div className="panel panel-right">
          <div className="gantt-header-row">
            <h2>Gantt Chart</h2>
            <div className="zoom-controls">
              {(['day', 'week', 'month'] as ZoomUnit[]).map((unit) => (
                <button
                  key={unit}
                  type="button"
                  className={zoom === unit ? 'zoom-btn zoom-btn-active' : 'zoom-btn'}
                  onClick={() => setZoom(unit)}
                >
                  {ZOOM_CONFIG[unit].label}
                </button>
              ))}
            </div>
          </div>
          <div
            className="gantt-scroll board-panel-scroll"
            ref={ganttScrollRef}
            onScroll={() => {
              const el = ganttScrollRef.current
              if (!el) return
              setGanttScrollLeft(el.scrollLeft)
              syncVerticalScroll('right')
            }}
          >
            <div
              className="gantt-inner"
              style={{
                width: `${timelineContentWidth}px`,
                ['--unit-width' as string]: `${timelineMeta.unitWidth}px`,
              }}
            >
              <div
                className="gantt-calendar"
                style={{
                  gridAutoColumns: `${timelineMeta.unitWidth}px`,
                }}
              >
                {timelineTicks.map((tick) => (
                  <div key={tick.key} className={`gantt-day-cell${tick.isWeekend ? ' gantt-day-cell--weekend' : ''}`}>
                    <span className="gantt-month-label">{tick.top}</span>
                    <span className="gantt-day-label">{tick.bottom}</span>
                  </div>
                ))}
              </div>

              <div className="rows rows-scrollable gantt-rows-scrollable">
                {taskRows.map(({ task }) => {
                  const effectiveTask = effectiveTaskMap.get(task.id) ?? task
                  const mhTrim = (effectiveTask.mh_md ?? '').trim()
                  const plannedStyle = getBarStyle(effectiveTask.planned_start_date, effectiveTask.planned_end_date)
                  return (
                    <div
                      key={task.id}
                      title={task.name}
                      className={`row gantt-row ${draggedTaskId === task.id ? 'gantt-row-dragging' : ''} ${dragOver?.targetId === task.id ? 'gantt-row-target' : ''}`}
                    >
                      <div className="gantt-row-bars">
                        <div className="gantt-track gantt-track-planned">
                          {plannedStyle ? (
                            <>
                              <div className="gantt-bar gantt-bar-planned" style={plannedStyle} />
                              {mhTrim ? (
                                <span className="gantt-mh-md-label" style={plannedStyle}>
                                  {mhTrim}
                                </span>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                        <div className="gantt-track">
                          {(() => {
                            const actualStyle = getBarStyle(effectiveTask.actual_start_date, effectiveTask.actual_end_date)
                            if (!actualStyle) return null
                            return (
                              <div className={`gantt-bar ${getStatusClass(effectiveTask.status)}`} style={actualStyle}>
                                <span className="gantt-progress" style={{ width: `${effectiveTask.progress}%` }} />
                                <span className="gantt-label">{effectiveTask.progress}%</span>
                              </div>
                            )
                          })()}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          <input
            className="h-scroll-control"
            type="range"
            min={0}
            max={Math.max(1, ganttScrollMax)}
            value={Math.min(ganttScrollLeft, Math.max(1, ganttScrollMax))}
            onChange={(event) => {
              const next = Number(event.target.value)
              setGanttScrollLeft(next)
              if (ganttScrollRef.current) ganttScrollRef.current.scrollLeft = next
            }}
            disabled={ganttScrollMax <= 0}
          />
          <p className="timeline-caption">
            Period: {new Date(minStart).toLocaleDateString()} - {new Date(maxEnd).toLocaleDateString()}
          </p>
        </div>
        </div>
      </section>


      {selectedTask && (
        <section className="editor">
          <h2>Progress Update</h2>
          <div className="actions">
            <button type="button" onClick={() => addTask(selectedTask.parent_id)}>
              Add Task
            </button>
            <button type="button" onClick={() => addTask(selectedTask.id)}>
              Add Child Task
            </button>
            <button type="button" onClick={() => moveTask(selectedTask.id, 'up')}>
              Up
            </button>
            <button type="button" onClick={() => moveTask(selectedTask.id, 'down')}>
              Down
            </button>
            <button type="button" onClick={() => levelUp(selectedTask.id)} disabled={!canLevelUp}>
              Level up
            </button>
            <button type="button" onClick={() => levelDown(selectedTask.id)} disabled={!canLevelDown}>
              Level down
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                const ok = window.confirm(`Delete task "${selectedTask.name}"?`)
                if (!ok) return
                removeTask(selectedTask.id)
              }}
              disabled={tasks.length <= 1}
            >
              Delete
            </button>
          </div>
          <div className="editor-grid">
            <div className="editor-task-fields-row">
              <label className="editor-field-task-name">
                Task Name
                <input
                  value={selectedTask.name}
                  onChange={(event) => updateTask(selectedTask.id, 'name', event.target.value)}
                />
              </label>
              <label className="editor-field-mh-md">
                MH/MD
                <input
                  value={(effectiveTaskMap.get(selectedTask.id) ?? selectedTask).mh_md}
                  onChange={(event) => {
                    if (hasChildren) return
                    updateTask(selectedTask.id, 'mh_md', event.target.value)
                  }}
                  placeholder="e.g. 8 MD"
                  maxLength={32}
                  disabled={hasChildren}
                  title={hasChildren ? '親タスクの MH/MD は子タスクの合計です（編集は子で行ってください）' : undefined}
                />
              </label>
              <label className="editor-field-role-narrow">
                Role
                <input
                  value={selectedTask.role}
                  onChange={(event) => updateTask(selectedTask.id, 'role', event.target.value)}
                />
              </label>
              <label className="editor-field-status-narrow">
                Status
                <select
                  value={selectedComputedStatus}
                  onChange={() => undefined}
                  disabled
                >
                  <option value="Not Started">Not Started</option>
                  <option value="On process">On process</option>
                  <option value="Finished">Finished</option>
                </select>
              </label>
            </div>
            <div className="date-pair">
              <label>
                Planned Start
                <input
                  type="date"
                  lang="en-CA"
                  value={selectedTask.planned_start_date}
                  onChange={(event) => updateTask(selectedTask.id, 'planned_start_date', event.target.value)}
                />
              </label>
              <label>
                Planned End
                <input
                  type="date"
                  lang="en-CA"
                  value={selectedTask.planned_end_date}
                  onChange={(event) => updateTask(selectedTask.id, 'planned_end_date', event.target.value)}
                />
              </label>
            </div>
            <div className="date-pair">
              <label>
                Actual Start
                <input
                  type="date"
                  lang="en-CA"
                  value={selectedTask.actual_start_date}
                  onChange={(event) => updateTask(selectedTask.id, 'actual_start_date', event.target.value)}
                />
              </label>
              <label>
                Actual End
                <input
                  type="date"
                  lang="en-CA"
                  value={selectedTask.actual_end_date}
                  onChange={(event) => updateTask(selectedTask.id, 'actual_end_date', event.target.value)}
                />
              </label>
            </div>
          </div>
          <label className="progress-editor">
            Progress: {selectedTask.progress}%
            <input
              type="range"
              min={0}
              max={100}
              value={selectedTask.progress}
              onChange={(event) => updateTask(selectedTask.id, 'progress', Number(event.target.value))}
              disabled={hasChildren}
            />
          </label>
          {hasChildren ? (
            <p className="hint">Parent task status/progress are auto-aggregated from child tasks.</p>
          ) : null}
        </section>
      )}

      <footer className="app-footer">WBS Viewer v1.0 powered by PT.BAHTERA HISISTEM INDONESIA</footer>
    </main>
  )
}

export default App
