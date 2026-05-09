import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import './App.css'
import logoImg from './assets/wbs-viewer-logo.png'
import {
  emptyProjectBundle,
  initialTasks,
  NEW_PROJECT_DEFAULT_TASKS,
  type IssueItem,
  type MomDocument,
  type MomHeader,
  type MomItem,
  type ProjectBundle,
  type SystemOverviewItem,
  type Task,
  type TaskStatus,
  type ZoomUnit,
} from './wbsDefaults'
import {
  clampGanttUnitScale,
  GANTT_UNIT_SCALE_STORAGE_KEY,
  readGanttUnitScaleFromLocalStorage,
  ZOOM_STORAGE_KEY,
} from './lib/wbsSqlite'
import { emptyDefaultSnapshot, GANTT_UNIT_SCALE_MAX, GANTT_UNIT_SCALE_MIN } from './lib/wbsSqlite'
import { openWbsSqlite, type WbsDbApi } from './lib/wbsSnapshotApi'

const DAY_MS = 24 * 60 * 60 * 1000
const WBS_TAB_EDIT_LOCK_KEY = 'wbs-tab-edit-lock-v1'
const WBS_TAB_EDIT_LOCK_HEARTBEAT_MS = 2000
const WBS_TAB_EDIT_LOCK_TTL_MS = 8000
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
  if (status === 'In Process') return 'status-process'
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
  return 'In Process'
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

/** `10MH`, `10 MD`, `8.5md` のように数値＋MH/MD のみ（親への合計表示に使う）。 */
const MH_MD_ROLLUP_STRICT = /^\s*(\d+(?:\.\d+)?)\s*(MH|MD)\s*$/i

function isMhMdRollupFormat(s: string): boolean {
  return MH_MD_ROLLUP_STRICT.test(String(s ?? '').trim())
}

function strictMhMdUnit(s: string): 'MH' | 'MD' | null {
  const m = String(s ?? '').trim().match(MH_MD_ROLLUP_STRICT)
  if (!m) return null
  return m[2].toUpperCase() === 'MH' ? 'MH' : 'MD'
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

function makeEmptyIssue(nextId: number): IssueItem {
  return {
    id: nextId,
    status: '',
    type: '',
    issued_by: '',
    issue: '',
    due_date: '',
    pic: '',
    created_on: '',
    updated_on: '',
    progress: '',
  }
}

function makeEmptySystemOverview(nextId: number): SystemOverviewItem {
  return {
    id: nextId,
    title: '',
    image_data_url: '',
    description: '',
  }
}

function makeEmptyMomItem(nextId: number): MomItem {
  return {
    id: nextId,
    type: '',
    content: '',
    issue_list_no: '',
    pic: '',
    due_date: '',
    remarks: '',
  }
}

function sortedDistinctIssueIsoDates(issues: IssueItem[], key: 'created_on' | 'due_date'): string[] {
  const set = new Set<string>()
  for (const item of issues) {
    const v = item[key].trim()
    if (v) set.add(v)
  }
  return Array.from(set).sort((a, b) => {
    const ta = parseTaskDate(a)
    const tb = parseTaskDate(b)
    if (ta === null && tb === null) return a.localeCompare(b)
    if (ta === null) return 1
    if (tb === null) return -1
    return ta - tb
  })
}

/** Multiline fields: row height follows content. Re-syncs when tab leaves `display:none` (ResizeObserver) and after layout (rAF). */
function IssueMultilineTextarea(props: Omit<React.ComponentProps<'textarea'>, 'rows'>) {
  const { className, onChange, value, ...rest } = props
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    const sync = () => {
      if (cancelled || !el.isConnected) return
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
      if (document.activeElement === el) {
        // Keep the editing field visible only when it grows below the visible area.
        // Avoid upward auto-scroll that can feel jumpy while typing.
        const scroller = (() => {
          let p: HTMLElement | null = el.parentElement
          while (p) {
            const style = getComputedStyle(p)
            const overflowY = style.overflowY
            if (overflowY === 'auto' || overflowY === 'scroll') return p
            p = p.parentElement
          }
          return null
        })()
        if (scroller) {
          const elRect = el.getBoundingClientRect()
          const scrollerRect = scroller.getBoundingClientRect()
          const gap = elRect.bottom - scrollerRect.bottom
          if (gap > 0) scroller.scrollTop += gap + 8
        }
      }
    }
    sync()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sync()
      })
    })
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(sync)
    })
    ro.observe(el)
    return () => {
      cancelled = true
      ro.disconnect()
    }
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      className={className}
      value={value}
      onChange={onChange}
      {...rest}
    />
  )
}

function TabHeaderProjectPickers({
  projectName,
  onProjectNameChange,
  companyFilter,
  onCompanyFilterChange,
  filteredProjectNames,
  distinctCompaniesForFilter,
}: {
  projectName: string
  onProjectNameChange: (name: string) => void
  companyFilter: string
  onCompanyFilterChange: (filter: string) => void
  filteredProjectNames: string[]
  distinctCompaniesForFilter: string[]
}) {
  return (
    <div className="tab-header-project-controls" role="group" aria-label="Project and company filter">
      <label className="tab-header-project-controls__project">
        <span className="tab-header-project-controls__label">Project</span>
        <select value={projectName} onChange={(e) => onProjectNameChange(e.target.value)}>
          <option value="">プロジェクトを選択…</option>
          {filteredProjectNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="tab-header-project-controls__company">
        <span className="tab-header-project-controls__label">会社で絞り込み</span>
        <select
          value={companyFilter}
          onChange={(e) => onCompanyFilterChange(e.target.value)}
          aria-label="会社で絞り込み"
        >
          <option value="">すべて</option>
          {distinctCompaniesForFilter.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
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
        status: (() => {
          const rawStatus = String((task as { status?: unknown }).status ?? '')
          if (rawStatus === 'Finished' || rawStatus === 'Not Started' || rawStatus === 'In Process') {
            return rawStatus as TaskStatus
          }
          if (rawStatus === 'On process') return 'In Process'
          return 'Not Started'
        })(),
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
  type TabEditLockPayload = { ownerId: string; ownerLabel: string; expiresAt: number }
  const tabIdRef = useRef(
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const tabLabelRef = useRef(`Tab-${tabIdRef.current.slice(0, 8)}`)
  const [hasEditLock, setHasEditLock] = useState(true)
  const [lockOwnerLabel, setLockOwnerLabel] = useState('')
  const wbsDbRef = useRef<WbsDbApi | null>(null)
  const [dbReady, setDbReady] = useState(false)
  const [dbHydrated, setDbHydrated] = useState(false)
  const [persistWarning, setPersistWarning] = useState('')
  const [lastSavedAtLabel, setLastSavedAtLabel] = useState('')
  const [retryingPersist, setRetryingPersist] = useState(false)
  const [restoringBackup, setRestoringBackup] = useState(false)
  const [loadingBackupDates, setLoadingBackupDates] = useState(false)
  const [backupDates, setBackupDates] = useState<string[]>([])
  const [selectedBackupDate, setSelectedBackupDate] = useState('')
  const recoveringFromConflictRef = useRef(false)

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
  const issueScrollRef = useRef<HTMLDivElement | null>(null)
  const syncingScrollRef = useRef(false)
  const tasksBelongToProjectRef = useRef(mountSnapshot.selectedProjectName)
  const [wbsScrollLeft, setWbsScrollLeft] = useState(0)
  const [wbsScrollMax, setWbsScrollMax] = useState(0)
  const [ganttScrollLeft, setGanttScrollLeft] = useState(0)
  const [ganttScrollMax, setGanttScrollMax] = useState(0)
  const [issueScrollLeft, setIssueScrollLeft] = useState(0)
  const [issueScrollMax, setIssueScrollMax] = useState(0)
  const [activeMenu, setActiveMenu] = useState<'wbs' | 'issues' | 'mom' | 'system_overview'>('wbs')
  const [issueStatusFilter, setIssueStatusFilter] = useState('')
  const [issueTypeFilter, setIssueTypeFilter] = useState('')
  const [issueSubmitterFilter, setIssueSubmitterFilter] = useState('')
  const [issueCreatedFilter, setIssueCreatedFilter] = useState('')
  const [issueDueDateFilter, setIssueDueDateFilter] = useState('')
  const [issuePicFilter, setIssuePicFilter] = useState('')
  const [issueDateSort, setIssueDateSort] = useState<{ key: 'created_on' | 'due_date'; dir: 'asc' | 'desc' } | null>(null)
  const [overviewImageZoomById, setOverviewImageZoomById] = useState<Record<number, number>>({})
  const [selectedMomIdByProject, setSelectedMomIdByProject] = useState<Record<string, number | null>>({})
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

  const [ganttUnitScalePercent, setGanttUnitScalePercent] = useState(() => readGanttUnitScaleFromLocalStorage())
  const ganttUnitScaleRef = useRef(ganttUnitScalePercent)
  ganttUnitScaleRef.current = ganttUnitScalePercent

  const markPersistSuccess = () => {
    setPersistWarning('')
    setLastSavedAtLabel(
      new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    )
  }

  const persistCurrentSnapshot = async (context: string) => {
    if (recoveringFromConflictRef.current) return false
    if (!hasEditLock) {
      setPersistWarning(
        `別タブ(${lockOwnerLabel || '他タブ'})が編集中のため、このタブでは保存できません。編集タブを閉じるか、こちらを再読み込みしてください。`,
      )
      return false
    }
    const projectCount = Object.keys(projectsRef.current).length
    if ((context === 'persistSnapshot' || context === 'persist flush') && projectCount === 0) {
      return false
    }
    const api = wbsDbRef.current
    if (!api) {
      setPersistWarning('保存に失敗しました。ローカルDBへ同期できていません。')
      return false
    }
    try {
      await api.persistSnapshot({
        selectedProjectName: projectNameRef.current,
        projects: projectsRef.current,
        zoom: zoomRef.current,
        ganttUnitScalePercent: ganttUnitScaleRef.current,
      })
      markPersistSuccess()
      return true
    } catch (err) {
      console.error(`[wbs] ${context} failed`, err)
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('HTTP 409') && !recoveringFromConflictRef.current) {
        recoveringFromConflictRef.current = true
        setPersistWarning('保存競合を検出しました。DBを再読込しています…')
        setDbHydrated(false)
        try {
          const freshApi = await openWbsSqlite(parseTasksJson)
          wbsDbRef.current?.close()
          wbsDbRef.current = freshApi
          const snap = freshApi.readSnapshot()
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
          setGanttUnitScalePercent(snap.ganttUnitScalePercent)
          setDbHydrated(true)
          setPersistWarning('保存競合のため最新DBを再読込しました。必要なら編集をやり直してください。')
        } catch (reloadErr) {
          console.error('[wbs] reload after conflict failed', reloadErr)
          setPersistWarning('保存競合を検出しました。ページ再読み込み後に再試行してください。')
        } finally {
          recoveringFromConflictRef.current = false
        }
        return false
      }
      setPersistWarning('保存に失敗しました。ローカルDBへ同期できていません。')
      return false
    }
  }

  useEffect(() => {
    const parseLock = (): TabEditLockPayload | null => {
      try {
        const raw = localStorage.getItem(WBS_TAB_EDIT_LOCK_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as Partial<TabEditLockPayload>
        if (
          typeof parsed.ownerId !== 'string' ||
          typeof parsed.ownerLabel !== 'string' ||
          typeof parsed.expiresAt !== 'number'
        ) {
          return null
        }
        return { ownerId: parsed.ownerId, ownerLabel: parsed.ownerLabel, expiresAt: parsed.expiresAt }
      } catch {
        return null
      }
    }

    const writeLock = () => {
      const payload: TabEditLockPayload = {
        ownerId: tabIdRef.current,
        ownerLabel: tabLabelRef.current,
        expiresAt: Date.now() + WBS_TAB_EDIT_LOCK_TTL_MS,
      }
      localStorage.setItem(WBS_TAB_EDIT_LOCK_KEY, JSON.stringify(payload))
      return payload
    }

    const releaseLock = () => {
      const current = parseLock()
      if (current?.ownerId === tabIdRef.current) {
        localStorage.removeItem(WBS_TAB_EDIT_LOCK_KEY)
      }
    }

    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(WBS_TAB_EDIT_LOCK_KEY) : null
    const announce = () => {
      channel?.postMessage({ ts: Date.now() })
    }

    const refreshLockState = () => {
      const current = parseLock()
      const now = Date.now()
      if (!current || current.expiresAt <= now || current.ownerId === tabIdRef.current) {
        const own = writeLock()
        setHasEditLock(true)
        setLockOwnerLabel(own.ownerLabel)
        setPersistWarning((prev) =>
          prev.includes('別タブ') ? '' : prev,
        )
        announce()
        return
      }
      setHasEditLock(false)
      setLockOwnerLabel(current.ownerLabel)
    }

    refreshLockState()
    const heartbeat = window.setInterval(() => {
      const current = parseLock()
      const now = Date.now()
      if (!current || current.expiresAt <= now || current.ownerId === tabIdRef.current) {
        writeLock()
        setHasEditLock(true)
        announce()
      } else {
        setHasEditLock(false)
        setLockOwnerLabel(current.ownerLabel)
      }
    }, WBS_TAB_EDIT_LOCK_HEARTBEAT_MS)

    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key !== WBS_TAB_EDIT_LOCK_KEY) return
      refreshLockState()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshLockState()
    }
    const onPageHide = () => {
      releaseLock()
      announce()
    }
    const onChannelMessage = () => refreshLockState()

    window.addEventListener('storage', onStorage)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    channel?.addEventListener('message', onChannelMessage)

    return () => {
      window.clearInterval(heartbeat)
      releaseLock()
      announce()
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      channel?.removeEventListener('message', onChannelMessage)
      channel?.close()
    }
  }, [])

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
        if (cancelled) {
          api.close()
          return
        }
        wbsDbRef.current?.close()
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
        setGanttUnitScalePercent(snap.ganttUnitScalePercent)
        setDbHydrated(true)
      } catch (err) {
        console.error('SQLite init failed', err)
        const detail = err instanceof Error ? err.message : String(err)
        setPersistWarning(`ローカルDBの初期化に失敗しました（${detail}）。`)
      } finally {
        if (!cancelled) setDbReady(true)
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
      wbsDbRef.current?.close()
      wbsDbRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!dbReady || !dbHydrated || !wbsDbRef.current || !hasEditLock) return
    const handle = setTimeout(() => {
      void persistCurrentSnapshot('persistSnapshot')
    }, 150)
    return () => clearTimeout(handle)
  }, [dbReady, dbHydrated, hasEditLock, projectName, projects, zoom, ganttUnitScalePercent])

  useEffect(() => {
    if (!dbReady || !dbHydrated || !hasEditLock) return
    const flush = () => {
      void persistCurrentSnapshot('persist flush')
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
    }
  }, [dbReady, dbHydrated, hasEditLock])

  useEffect(() => {
    localStorage.setItem(ZOOM_STORAGE_KEY, zoom)
  }, [zoom])

  useEffect(() => {
    try {
      localStorage.setItem(GANTT_UNIT_SCALE_STORAGE_KEY, String(clampGanttUnitScale(ganttUnitScalePercent)))
    } catch {
      /* ignore */
    }
  }, [ganttUnitScalePercent])

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
    setIssueDateSort(null)
    setIssueStatusFilter('')
    setIssueTypeFilter('')
    setIssueSubmitterFilter('')
    setIssueCreatedFilter('')
    setIssueDueDateFilter('')
    setIssuePicFilter('')
  }, [projectName])

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
      const hasProcess = effectiveChildren.some((child) => child.status === 'In Process')
      const hasNotStarted = effectiveChildren.some((child) => child.status === 'Not Started')
      const status: TaskStatus = average >= 100 ? 'Finished' : hasProcess || !hasNotStarted ? 'In Process' : 'Not Started'

      const childrenWithMh = effectiveChildren.filter((c) => (c.mh_md ?? '').trim() !== '')
      const allStrictRollupFormat =
        childrenWithMh.length > 0 && childrenWithMh.every((c) => isMhMdRollupFormat(c.mh_md ?? ''))
      const firstUnit = allStrictRollupFormat ? strictMhMdUnit(childrenWithMh[0].mh_md ?? '') : null
      const uniformStrictUnit =
        allStrictRollupFormat &&
        firstUnit != null &&
        childrenWithMh.every((c) => strictMhMdUnit(c.mh_md ?? '') === firstUnit)

      let rolledMhMd = task.mh_md ?? ''
      if (uniformStrictUnit && firstUnit) {
        const sumMhMd = effectiveChildren.reduce((sum, child) => sum + parseMhMdNumeric(child.mh_md ?? ''), 0)
        rolledMhMd = formatMhMdRollup(sumMhMd, firstUnit)
      }

      const aggregated: Task = {
        ...task,
        progress: average,
        status,
        mh_md: rolledMhMd,
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
    if (poLabel) parts.push(`PO on ${poLabel}`)
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

  /** 会社で絞り込んだうえでの Project 一覧（未指定なら全件）。フィルターに合わない選択は useLayoutEffect で先頭へ切り替え。 */
  const filteredProjectNames = useMemo(() => {
    const cf = companyFilter.trim()
    if (!cf) return [...allProjectNames]
    return allProjectNames.filter((name) => (projects[name]?.company ?? '').trim() === cf)
  }, [allProjectNames, companyFilter, projects])

  useLayoutEffect(() => {
    if (!filteredProjectNames.length) {
      if (companyFilter.trim() && allProjectNames.length > 0) {
        setCompanyFilter('')
      }
      if (projectName) setProjectName('')
      return
    }
    if (!projectName || !filteredProjectNames.includes(projectName)) {
      setProjectName(filteredProjectNames[0])
    }
  }, [allProjectNames.length, companyFilter, filteredProjectNames, projectName])

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
    const { unitWidth: baseUw, minWidth: baseMw } = ZOOM_CONFIG[zoom]
    const s = clampGanttUnitScale(ganttUnitScalePercent) / 100
    const unitWidth = Math.max(12, Math.round(baseUw * s))
    const minWidth = Math.max(320, Math.round(baseMw * s))

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
  }, [ganttUnitScalePercent, maxEnd, minStart, zoom])

  /** Pixel width of the date grid only (bars must use this, not minWidth stretch). */
  const timelineContentWidth = timelineMeta.totalUnits * timelineMeta.unitWidth

  useEffect(() => {
    const syncScrollMeta = () => {
      const wbsEl = wbsScrollRef.current
      const ganttEl = ganttScrollRef.current
      const issueEl = issueScrollRef.current
      if (wbsEl) {
        setWbsScrollLeft(wbsEl.scrollLeft)
        setWbsScrollMax(Math.max(0, wbsEl.scrollWidth - wbsEl.clientWidth))
      }
      if (ganttEl) {
        setGanttScrollLeft(ganttEl.scrollLeft)
        setGanttScrollMax(Math.max(0, ganttEl.scrollWidth - ganttEl.clientWidth))
      }
      if (issueEl) {
        setIssueScrollLeft(issueEl.scrollLeft)
        setIssueScrollMax(Math.max(0, issueEl.scrollWidth - issueEl.clientWidth))
      }
    }

    const rafId = requestAnimationFrame(syncScrollMeta)
    window.addEventListener('resize', syncScrollMeta)
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', syncScrollMeta)
    }
  }, [activeMenu, ganttUnitScalePercent, projectName, projects, tasks, zoom, timelineContentWidth])

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
    const canScrollPanel = container.scrollHeight > container.clientHeight + 2

    if (clientY < rect.top + threshold) {
      if (canScrollPanel) {
        container.scrollTop -= speed
        syncVerticalScroll('left')
      } else {
        window.scrollBy(0, -speed)
      }
    } else if (clientY > rect.bottom - threshold) {
      if (canScrollPanel) {
        container.scrollTop += speed
        syncVerticalScroll('left')
      } else {
        window.scrollBy(0, speed)
      }
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
        role: '',
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
      void persistCurrentSnapshot('persist after createProject')
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
    const currentCompany = (projects[projectName]?.company ?? '').trim()
    const ok = window.confirm(
      currentCompany
        ? `Delete company "${currentCompany}" from project "${projectName}"?`
        : `Delete company setting from project "${projectName}"?`,
    )
    if (!ok) return
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
      issues: (bundle.issues ?? []).map((item) => ({ ...item })),
      system_overview: (bundle.system_overview ?? []).map((item) => ({ ...item })),
      mom_documents: (bundle.mom_documents ?? []).map((doc) => ({
        id: doc.id,
        header: { ...doc.header },
        items: (doc.items ?? []).map((item) => ({ ...item })),
      })),
    }
    tasksBelongToProjectRef.current = trimmed
    setProjects(next)
    setProjectName(trimmed)
    projectsRef.current = next
    projectNameRef.current = trimmed
    if (wbsDbRef.current) {
      void persistCurrentSnapshot('persist after project rename')
    }
  }

  const deleteProject = () => {
    if (!projectName || !projects[projectName]) return
    const ok = window.confirm(`Delete project "${projectName}"?`)
    if (!ok) return
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
      void persistCurrentSnapshot('persist after deleteProject')
    }
  }

  const loadBackupDates = async () => {
    setLoadingBackupDates(true)
    try {
      const listRes = await fetch('/__wbs_sqlite/backups', { cache: 'no-store' })
      if (!listRes.ok) {
        throw new Error(`backup list HTTP ${listRes.status}`)
      }
      const payload = (await listRes.json()) as { dates?: unknown }
      const dates = Array.isArray(payload.dates)
        ? payload.dates.filter((d): d is string => typeof d === 'string')
        : []
      setBackupDates(dates)
      setSelectedBackupDate((current) => (current && dates.includes(current) ? current : dates[0] ?? ''))
    } catch (err) {
      console.error('[wbs] backup date list failed', err)
      setBackupDates([])
      setSelectedBackupDate('')
      window.alert('バックアップ日付一覧の取得に失敗しました。コンソールログを確認してください。')
    } finally {
      setLoadingBackupDates(false)
    }
  }

  const recoverProjectsFromBackup = async () => {
    if (restoringBackup) return
    if (!selectedBackupDate) {
      window.alert('復旧する日付を選択してください。')
      return
    }
    const confirmed = window.confirm(
      `${selectedBackupDate} のバックアップへ復旧します。現在のDBは上書きされます。続行しますか？`,
    )
    if (!confirmed) return
    setRestoringBackup(true)
    try {
      const restoreRes = await fetch(`/__wbs_sqlite/restore?date=${encodeURIComponent(selectedBackupDate)}`, {
        method: 'POST',
      })
      if (!restoreRes.ok) throw new Error(`restore HTTP ${restoreRes.status}`)
      window.alert(`${selectedBackupDate} のバックアップに復旧しました。画面を再読み込みします。`)
      window.location.reload()
    } catch (err) {
      console.error('[wbs] backup restore failed', err)
      window.alert('バックアップ復旧に失敗しました。コンソールログを確認してください。')
    } finally {
      setRestoringBackup(false)
    }
  }

  useEffect(() => {
    void loadBackupDates()
  }, [])

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
    if (!projectName) return
    if (activeMenu === 'wbs' && !tasks.length) return
    const ExcelJS = (await import('exceljs')).default

    if (activeMenu === 'system_overview') {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('Overview')
      const overviewHeaders = ['No', 'Title', 'Image', 'Description']
      sheet.addRow(overviewHeaders)

      const items = activeSystemOverviewItems
      items.forEach((item, idx) => {
        const rowNumber = sheet.rowCount + 1
        sheet.addRow([idx + 1, item.title, '', item.description])

        if (item.image_data_url) {
          const mimeMatch = /^data:(image\/[a-zA-Z0-9+.-]+);base64,/.exec(item.image_data_url)
          const mime = mimeMatch?.[1]?.toLowerCase() ?? ''
          const extension =
            mime === 'image/png'
              ? 'png'
              : mime === 'image/jpeg' || mime === 'image/jpg'
                ? 'jpeg'
                : mime === 'image/gif'
                  ? 'gif'
                  : undefined
          if (extension) {
            const imageId = workbook.addImage({
              base64: item.image_data_url,
              extension,
            })
            sheet.addImage(imageId, {
              tl: { col: 2 + 0.1, row: rowNumber - 1 + 0.1 },
              ext: { width: 360, height: 200 },
            })
            sheet.getRow(rowNumber).height = 150
          }
        }
      })

      const totalRows = sheet.rowCount
      const totalCols = overviewHeaders.length
      for (let r = 1; r <= totalRows; r += 1) {
        for (let c = 1; c <= totalCols; c += 1) {
          const cell = sheet.getCell(r, c)
          cell.font = { name: 'Meiryo UI', size: 10 }
          cell.alignment = { vertical: 'top', horizontal: c === 4 ? 'left' : 'center', wrapText: true }
          cell.border = {
            top: { style: 'thin', color: { argb: 'FF4B5563' } },
            left: { style: 'thin', color: { argb: 'FF4B5563' } },
            bottom: { style: 'thin', color: { argb: 'FF4B5563' } },
            right: { style: 'thin', color: { argb: 'FF4B5563' } },
          }
        }
      }

      if (totalRows >= 1) {
        const headerRow = sheet.getRow(1)
        headerRow.font = { name: 'Meiryo UI', size: 10, bold: true }
        headerRow.height = 22
      }

      sheet.columns = [{ width: 6 }, { width: 28 }, { width: 52 }, { width: 52 }]

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'overview-export.xlsx'
      anchor.click()
      URL.revokeObjectURL(url)
      return
    }

    if (activeMenu === 'issues') {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('Issue_List')
      const issueHeaders = ['No', 'Created', 'Status', 'Type', 'Submit', 'Issue', 'Due Date', 'PIC', 'Progress']
      sheet.addRow(issueHeaders)

      sortedFilteredIssues.forEach((item, idx) => {
        sheet.addRow([
          idx + 1,
          item.created_on,
          item.status,
          item.type,
          item.issued_by,
          item.issue,
          item.due_date,
          item.pic,
          item.progress,
        ])
      })

      const totalRows = sheet.rowCount
      const totalCols = issueHeaders.length
      for (let r = 1; r <= totalRows; r += 1) {
        for (let c = 1; c <= totalCols; c += 1) {
          const cell = sheet.getCell(r, c)
          cell.font = { name: 'Meiryo UI', size: 10 }
          cell.alignment = { vertical: 'middle', horizontal: c === 6 || c === 9 ? 'left' : 'center', wrapText: true }
          cell.border = {
            top: { style: 'thin', color: { argb: 'FF4B5563' } },
            left: { style: 'thin', color: { argb: 'FF4B5563' } },
            bottom: { style: 'thin', color: { argb: 'FF4B5563' } },
            right: { style: 'thin', color: { argb: 'FF4B5563' } },
          }
        }
      }

      if (totalRows >= 1) {
        const headerRow = sheet.getRow(1)
        headerRow.font = { name: 'Meiryo UI', size: 10, bold: true }
      }
      sheet.columns = [
        { width: 6 },
        { width: 14 },
        { width: 14 },
        { width: 14 },
        { width: 14 },
        { width: 40 },
        { width: 14 },
        { width: 14 },
        { width: 24 },
      ]

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'issue-list-export.xlsx'
      anchor.click()
      URL.revokeObjectURL(url)
      return
    }

    if (activeMenu === 'mom') {
      if (!activeMomDoc) return
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('MOM')
      const momHeaders = ['No', 'Type', 'Topic', 'Issue No', 'Content', 'PIC', 'Due Date']
      const headerPairs: Array<[string, string]> = [
        ['Title', activeMomHeader.title],
        ['Date', activeMomHeader.date],
        ['Time', activeMomHeader.time],
        ['Attendance', activeMomHeader.attendance],
        ['Location', activeMomHeader.location],
      ]

      headerPairs.forEach(([key, value]) => {
        sheet.addRow([key, value ?? ''])
      })
      sheet.addRow([])
      sheet.addRow(momHeaders)

      activeMomItems.forEach((item, idx) => {
        sheet.addRow([idx + 1, item.type, item.content, item.issue_list_no, item.remarks, item.pic, item.due_date])
      })

      const totalRows = sheet.rowCount
      const totalCols = momHeaders.length
      const tableStartRow = headerPairs.length + 2

      for (let r = 1; r <= totalRows; r += 1) {
        for (let c = 1; c <= totalCols; c += 1) {
          const cell = sheet.getCell(r, c)
          cell.font = { name: 'Meiryo UI', size: 10 }
          if (r >= tableStartRow) {
            cell.alignment = { vertical: 'top', horizontal: c === 3 || c === 5 ? 'left' : 'center', wrapText: true }
            cell.border = {
              top: { style: 'thin', color: { argb: 'FF4B5563' } },
              left: { style: 'thin', color: { argb: 'FF4B5563' } },
              bottom: { style: 'thin', color: { argb: 'FF4B5563' } },
              right: { style: 'thin', color: { argb: 'FF4B5563' } },
            }
          } else {
            cell.alignment = { vertical: 'middle', horizontal: c === 2 ? 'left' : 'center', wrapText: true }
          }
        }
      }

      sheet.getRow(tableStartRow).font = { name: 'Meiryo UI', size: 10, bold: true }
      sheet.columns = [{ width: 6 }, { width: 18 }, { width: 44 }, { width: 16 }, { width: 44 }, { width: 18 }, { width: 14 }]

      const safeDate = (activeMomHeader.date || '').trim() || 'undated'
      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `mom-${safeDate}.xlsx`
      anchor.click()
      URL.revokeObjectURL(url)
      return
    }

    const wbsRows = taskRows.map(({ task, depth }) => {
      const effectiveTask = effectiveTaskMap.get(task.id) ?? task
      const taskLabel = `${'    '.repeat(depth)}${task.name}`
      return {
        ID: task.id,
        Task: taskLabel,
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
        cell.alignment = { vertical: 'middle', horizontal: c === 2 ? 'left' : 'center' }
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

    // Match WBS Tree colors for MH/MD text by task level.
    // Level 1 (top): black, Level 2: blue, Level 3+: green.
    for (let i = 0; i < wbsRows.length; i += 1) {
      const excelRow = i + 3 // Row 1/2 are headers, Row 3 is first task.
      const level = Number(wbsRows[i].Level) || 1
      const colorArgb = level <= 1 ? 'FF0F172A' : level === 2 ? 'FF1D4ED8' : 'FF166534'
      const mhMdCell = sheet.getCell(excelRow, 5) // MH/MD column.
      mhMdCell.font = { ...(mhMdCell.font ?? {}), color: { argb: colorArgb } }
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
    const zoomLabel = zoom === 'day' ? 'daily' : zoom === 'week' ? 'weekly' : 'monthly'
    anchor.download = `wbs-gantt-export-${zoomLabel}.xlsx`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const hasCompanyOnProject = Boolean((projects[projectName]?.company ?? '').trim())
  const companyRenameDisabled = !projectName || (!hasCompanyOnProject && !companyUnlockPending)
  const companyAddDisabled = !projectName || hasCompanyOnProject
  const companyDeleteDisabled = !projectName || (!hasCompanyOnProject && !companyUnlockPending)
  const activeIssues = projects[projectName]?.issues ?? []
  const issueTypeOptions = useMemo(
    () =>
      Array.from(new Set(activeIssues.map((item) => item.type.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [activeIssues],
  )
  const issueSubmitterOptions = useMemo(
    () =>
      Array.from(new Set(activeIssues.map((item) => item.issued_by.trim()).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [activeIssues],
  )
  const issueCreatedOptions = useMemo(() => sortedDistinctIssueIsoDates(activeIssues, 'created_on'), [activeIssues])
  const issueDueDateOptions = useMemo(() => sortedDistinctIssueIsoDates(activeIssues, 'due_date'), [activeIssues])
  const issuePicOptions = useMemo(
    () => Array.from(new Set(activeIssues.map((item) => item.pic.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [activeIssues],
  )
  const filteredIssues = useMemo(
    () =>
      activeIssues.filter((item) => {
        if (issueStatusFilter && item.status !== issueStatusFilter) return false
        if (issueTypeFilter && item.type.trim() !== issueTypeFilter) return false
        if (issueSubmitterFilter && item.issued_by.trim() !== issueSubmitterFilter) return false
        if (issueCreatedFilter && item.created_on.trim() !== issueCreatedFilter) return false
        if (issueDueDateFilter && item.due_date.trim() !== issueDueDateFilter) return false
        if (issuePicFilter && item.pic.trim() !== issuePicFilter) return false
        return true
      }),
    [
      activeIssues,
      issueCreatedFilter,
      issueDueDateFilter,
      issuePicFilter,
      issueStatusFilter,
      issueSubmitterFilter,
      issueTypeFilter,
    ],
  )

  const sortedFilteredIssues = useMemo(() => {
    if (!issueDateSort) return filteredIssues
    const { key, dir } = issueDateSort
    const mult = dir === 'asc' ? 1 : -1
    return [...filteredIssues].sort((a, b) => {
      const ta = parseTaskDate(a[key].trim())
      const tb = parseTaskDate(b[key].trim())
      const emptyA = ta === null
      const emptyB = tb === null
      if (emptyA && emptyB) return a.id - b.id
      if (emptyA) return 1
      if (emptyB) return -1
      const diff = (ta - tb) * mult
      if (diff !== 0) return diff
      return a.id - b.id
    })
  }, [filteredIssues, issueDateSort])

  const toggleIssueDateSort = (key: 'created_on' | 'due_date') => {
    setIssueDateSort((prev) => {
      if (prev?.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      return { key, dir: 'asc' }
    })
  }

  const updateProjectIssues = (updater: (current: IssueItem[]) => IssueItem[]) => {
    if (!projectName) return
    setProjects((current) => {
      const bundle = current[projectName] ?? emptyProjectBundle(tasksRef.current.map((task) => ({ ...task })))
      const nextIssues = updater(bundle.issues ?? [])
      return { ...current, [projectName]: { ...bundle, issues: nextIssues } }
    })
  }

  const updateProjectSystemOverview = (updater: (current: SystemOverviewItem[]) => SystemOverviewItem[]) => {
    if (!projectName) return
    setProjects((current) => {
      const bundle = current[projectName] ?? emptyProjectBundle(tasksRef.current.map((task) => ({ ...task })))
      const nextItems = updater(bundle.system_overview ?? [])
      return { ...current, [projectName]: { ...bundle, system_overview: nextItems } }
    })
  }

  const addIssueRow = () => {
    updateProjectIssues((current) => {
      const nextId = current.reduce((max, item) => Math.max(max, item.id), 0) + 1
      return [...current, makeEmptyIssue(nextId)]
    })
  }

  const activeSystemOverviewItems = projects[projectName]?.system_overview ?? []
  const addSystemOverviewItem = () => {
    updateProjectSystemOverview((current) => {
      const nextId = current.reduce((max, item) => Math.max(max, item.id), 0) + 1
      return [...current, makeEmptySystemOverview(nextId)]
    })
  }
  const updateSystemOverviewItem = <K extends keyof SystemOverviewItem>(
    itemId: number,
    key: K,
    value: SystemOverviewItem[K],
  ) => {
    updateProjectSystemOverview((current) => current.map((item) => (item.id === itemId ? { ...item, [key]: value } : item)))
  }
  const removeSystemOverviewItem = (itemId: number) => {
    const ok = window.confirm('Delete this System Overview item?')
    if (!ok) return
    updateProjectSystemOverview((current) => current.filter((item) => item.id !== itemId))
  }
  const moveSystemOverviewItem = (itemId: number, direction: 'up' | 'down') => {
    updateProjectSystemOverview((current) => {
      const index = current.findIndex((item) => item.id === itemId)
      if (index < 0) return current
      const swapIndex = direction === 'up' ? index - 1 : index + 1
      if (swapIndex < 0 || swapIndex >= current.length) return current
      const next = [...current]
      const temp = next[index]
      next[index] = next[swapIndex]
      next[swapIndex] = temp
      return next
    })
  }

  const handleSystemOverviewImageSelect = (itemId: number, file: File | null) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      updateSystemOverviewItem(itemId, 'image_data_url', dataUrl)
    }
    reader.readAsDataURL(file)
  }

  const updateIssue = <K extends keyof IssueItem>(issueId: number, key: K, value: IssueItem[K]) => {
    updateProjectIssues((current) => current.map((item) => (item.id === issueId ? { ...item, [key]: value } : item)))
  }

  const removeIssue = (issueId: number) => {
    const target = activeIssues.find((item) => item.id === issueId)
    const ok = window.confirm(`Delete issue #${target ? activeIssues.indexOf(target) + 1 : issueId}?`)
    if (!ok) return
    updateProjectIssues((current) => current.filter((item) => item.id !== issueId))
  }
  const moveIssue = (issueId: number, direction: 'up' | 'down') => {
    updateProjectIssues((current) => {
      const index = current.findIndex((item) => item.id === issueId)
      if (index < 0) return current
      const swapIndex = direction === 'up' ? index - 1 : index + 1
      if (swapIndex < 0 || swapIndex >= current.length) return current
      const next = [...current]
      const temp = next[index]
      next[index] = next[swapIndex]
      next[swapIndex] = temp
      return next
    })
  }

  const momDocs: MomDocument[] = projects[projectName]?.mom_documents ?? []
  const selectedMomId = projectName ? (selectedMomIdByProject[projectName] ?? null) : null
  const activeMomDoc = (() => {
    if (!momDocs.length) return null
    if (selectedMomId !== null) {
      const hit = momDocs.find((doc) => doc.id === selectedMomId)
      if (hit) return hit
    }
    return momDocs[0]
  })()
  const activeMomHeader: MomHeader = activeMomDoc?.header ?? { title: '', date: '', time: '', attendance: '', location: '' }
  const activeMomItems: MomItem[] = activeMomDoc?.items ?? []

  useEffect(() => {
    if (!projectName) return
    if (!momDocs.length) {
      setSelectedMomIdByProject((current) => ({ ...current, [projectName]: null }))
      return
    }
    const currentSelected = selectedMomIdByProject[projectName]
    if (currentSelected !== null && currentSelected !== undefined && momDocs.some((doc) => doc.id === currentSelected)) return
    setSelectedMomIdByProject((current) => ({ ...current, [projectName]: momDocs[0].id }))
  }, [momDocs, projectName, selectedMomIdByProject])

  const updateProjectMomDocs = (updater: (current: MomDocument[]) => MomDocument[]) => {
    if (!projectName) return
    setProjects((current) => {
      const bundle = current[projectName] ?? emptyProjectBundle(tasksRef.current.map((task) => ({ ...task })))
      const nextDocs = updater(bundle.mom_documents ?? [])
      return { ...current, [projectName]: { ...bundle, mom_documents: nextDocs } }
    })
  }
  const newMom = () => {
    if (!projectName) return
    updateProjectMomDocs((current) => {
      const nextId = current.reduce((max, doc) => Math.max(max, doc.id), 0) + 1
      const doc: MomDocument = {
        id: nextId,
        header: { title: '', date: '', time: '', attendance: '', location: '' },
        items: [],
      }
      return [doc, ...current]
    })
    setSelectedMomIdByProject((current) => {
      const maxId = (momDocs.length ? Math.max(...momDocs.map((doc) => doc.id)) : 0) + 1
      return { ...current, [projectName]: maxId }
    })
  }
  const removeActiveMom = () => {
    if (!projectName || !activeMomDoc) return
    const targetDate = activeMomDoc.header.date || '日付未設定'
    const ok = window.confirm(`選択中のMOM（${targetDate}）を削除しますか？`)
    if (!ok) return
    const nextDocs = momDocs.filter((doc) => doc.id !== activeMomDoc.id)
    updateProjectMomDocs((current) => current.filter((doc) => doc.id !== activeMomDoc.id))
    setSelectedMomIdByProject((current) => ({
      ...current,
      [projectName]: nextDocs.length > 0 ? nextDocs[0].id : null,
    }))
  }
  const updateProjectMomHeader = <K extends keyof MomHeader>(key: K, value: MomHeader[K]) => {
    if (!activeMomDoc) return
    updateProjectMomDocs((current) =>
      current.map((doc) => (doc.id === activeMomDoc.id ? { ...doc, header: { ...doc.header, [key]: value } } : doc)),
    )
  }
  const updateProjectMomItems = (updater: (current: MomItem[]) => MomItem[]) => {
    if (!activeMomDoc) return
    updateProjectMomDocs((current) =>
      current.map((doc) => (doc.id === activeMomDoc.id ? { ...doc, items: updater(doc.items ?? []) } : doc)),
    )
  }
  const addMomRow = () => {
    updateProjectMomItems((current) => {
      const nextId = current.reduce((max, item) => Math.max(max, item.id), 0) + 1
      return [...current, makeEmptyMomItem(nextId)]
    })
  }
  const updateMomItem = <K extends keyof MomItem>(itemId: number, key: K, value: MomItem[K]) => {
    updateProjectMomItems((current) => current.map((item) => (item.id === itemId ? { ...item, [key]: value } : item)))
  }
  const removeMomItem = (itemId: number) => {
    const ok = window.confirm('Delete this MOM row?')
    if (!ok) return
    updateProjectMomItems((current) => current.filter((item) => item.id !== itemId))
  }
  const moveMomItem = (itemId: number, direction: 'up' | 'down') => {
    updateProjectMomItems((current) => {
      const index = current.findIndex((item) => item.id === itemId)
      if (index < 0) return current
      const swapIndex = direction === 'up' ? index - 1 : index + 1
      if (swapIndex < 0 || swapIndex >= current.length) return current
      const next = [...current]
      const temp = next[index]
      next[index] = next[swapIndex]
      next[swapIndex] = temp
      return next
    })
  }
  const copyMomItemToIssueList = (item: MomItem) => {
    if (!projectName) return
    const ok = window.confirm('Copy this row to Issue List?')
    if (!ok) return
    let createdIssueNo = ''
    updateProjectIssues((current) => {
      const nextId = current.reduce((max, issue) => Math.max(max, issue.id), 0) + 1
      createdIssueNo = String(nextId)
      return [
        ...current,
        {
          id: nextId,
          status: '',
          type: '',
          issued_by: '',
          issue: item.content,
          due_date: item.due_date,
          pic: item.pic,
          created_on: activeMomHeader.date,
          updated_on: '',
          progress: item.remarks,
        },
      ]
    })
    if (createdIssueNo) {
      updateMomItem(item.id, 'issue_list_no', createdIssueNo)
    }
  }

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
          <div className="app-header-brand">
            <img className="app-logo" src={logoImg} alt="WBS Viewer" />
            <div className="app-menu-tabs" role="tablist" aria-label="Main menu">
              <button
                type="button"
                role="tab"
                aria-selected={activeMenu === 'wbs'}
                className={activeMenu === 'wbs' ? 'menu-tab menu-tab-active' : 'menu-tab'}
                onClick={() => setActiveMenu('wbs')}
              >
                WBS
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeMenu === 'mom'}
                className={activeMenu === 'mom' ? 'menu-tab menu-tab-active' : 'menu-tab'}
                onClick={() => setActiveMenu('mom')}
              >
                MOM
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeMenu === 'issues'}
                className={activeMenu === 'issues' ? 'menu-tab menu-tab-active' : 'menu-tab'}
                onClick={() => setActiveMenu('issues')}
              >
                Issue List
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeMenu === 'system_overview'}
                className={activeMenu === 'system_overview' ? 'menu-tab menu-tab-active' : 'menu-tab'}
                onClick={() => setActiveMenu('system_overview')}
              >
                Overview
              </button>
            </div>
          </div>
          <button
            type="button"
            className="export-btn"
            onClick={() => void exportExcel()}
            disabled={!projectName || (activeMenu === 'wbs' && tasks.length === 0) || (activeMenu === 'mom' && !activeMomDoc)}
          >
            Export Excel
          </button>
        </div>
      </header>
      {persistWarning && (
        <div className="persist-warning-banner" role="alert">
          <span>{persistWarning}</span>
          <button
            type="button"
            className="persist-retry-btn"
            disabled={retryingPersist || !hasEditLock}
            onClick={() => {
              setRetryingPersist(true)
              void persistCurrentSnapshot('manual retry').finally(() => setRetryingPersist(false))
            }}
          >
            {retryingPersist ? '再試行中…' : '今すぐ再試行'}
          </button>
        </div>
      )}
      <div className="persist-status-line">
        最終保存: <strong>{lastSavedAtLabel || '未保存'}</strong>
      </div>

      <section className={`board ${activeMenu === 'wbs' ? '' : 'section-hidden'}`}>
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
                    <div className="editor-project-actions-stack">
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
                    <label className="board-project-col-company-narrow board-project-col-restore-date">
                      <span className="editor-project-subfield-label">復旧日付</span>
                      <select
                        value={selectedBackupDate}
                        onChange={(event) => setSelectedBackupDate(event.target.value)}
                        disabled={loadingBackupDates || restoringBackup || backupDates.length === 0}
                        aria-label="復旧日付"
                      >
                        {backupDates.length === 0 ? (
                          <option value="">{loadingBackupDates ? '読込中…' : '候補なし'}</option>
                        ) : (
                          backupDates.map((d) => (
                            <option key={d} value={d}>
                              {d}
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                    <div className="editor-project-actions-stack">
                      <button type="button" onClick={() => void loadBackupDates()} disabled={loadingBackupDates || restoringBackup}>
                        {loadingBackupDates ? '更新中…' : '候補更新'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void recoverProjectsFromBackup()}
                        disabled={restoringBackup || loadingBackupDates || !selectedBackupDate}
                      >
                        {restoringBackup ? '復旧中…' : '復旧'}
                      </button>
                    </div>
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
                      <option value="">すべて</option>
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
                    <div className="editor-project-actions-stack">
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
                    <span
                      className={`mh-md-cell mh-md-cell-level-${Math.min(depth, 2)}`}
                      title={(effectiveTaskMap.get(task.id) ?? task).mh_md ?? ''}
                    >
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
            <div className="gantt-header-controls">
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
              <label className="gantt-unit-scale" title="タイムライン1列あたりの横幅（行の高さは固定です）">
                <span className="gantt-unit-scale__label">列幅</span>
                <input
                  type="range"
                  className="gantt-unit-scale__range"
                  min={GANTT_UNIT_SCALE_MIN}
                  max={GANTT_UNIT_SCALE_MAX}
                  step={5}
                  value={ganttUnitScalePercent}
                  onChange={(e) => setGanttUnitScalePercent(clampGanttUnitScale(Number(e.target.value)))}
                  aria-label="ガントの列幅スケール"
                />
                <span className="gantt-unit-scale__value">{ganttUnitScalePercent}%</span>
              </label>
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


      <section className={`issue-list-panel ${activeMenu === 'issues' ? '' : 'section-hidden'}`}>
        <div className="issue-list-header">
          <h2>Issue List</h2>
          <TabHeaderProjectPickers
            projectName={projectName}
            onProjectNameChange={setProjectName}
            companyFilter={companyFilter}
            onCompanyFilterChange={setCompanyFilter}
            filteredProjectNames={filteredProjectNames}
            distinctCompaniesForFilter={distinctCompaniesForFilter}
          />
          <span className="wbs-current-project issue-current-project" title={wbsTreeHeaderCaption}>
            {wbsTreeHeaderCaption}
          </span>
          <button type="button" onClick={addIssueRow} disabled={!projectName}>
            Add Issue
          </button>
        </div>
        <input
          className="h-scroll-control"
          type="range"
          min={0}
          max={Math.max(1, issueScrollMax)}
          value={Math.min(issueScrollLeft, Math.max(1, issueScrollMax))}
          onChange={(event) => {
            const next = Number(event.target.value)
            setIssueScrollLeft(next)
            if (issueScrollRef.current) issueScrollRef.current.scrollLeft = next
          }}
          disabled={issueScrollMax <= 0}
        />
        <div
          className="issue-list-table-wrap"
          ref={issueScrollRef}
          onScroll={() => {
            const el = issueScrollRef.current
            if (!el) return
            setIssueScrollLeft(el.scrollLeft)
          }}
        >
          <table className="issue-list-table">
            <colgroup>
              <col className="issue-col-no" />
              <col className="issue-col-created" />
              <col className="issue-col-status" />
              <col className="issue-col-type" />
              <col className="issue-col-submitter" />
              <col className="issue-col-issue" />
              <col className="issue-col-due" />
              <col className="issue-col-pic" />
              <col className="issue-col-progress" />
              <col className="issue-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th>Issue No</th>
                <th className="issue-th-date issue-th-filter">
                  <div className="issue-th-with-sort-and-filter">
                    <button
                      type="button"
                      className="issue-th-sort-btn issue-th-sort-btn--center issue-th-sort-btn--inrow"
                      onClick={() => toggleIssueDateSort('created_on')}
                    >
                      Created
                      {issueDateSort?.key === 'created_on' ? (issueDateSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                    <select
                      className="issue-th-head-select"
                      value={issueCreatedFilter}
                      title={issueCreatedFilter || 'ALL'}
                      onChange={(e) => setIssueCreatedFilter(e.target.value)}
                    >
                      <option value="">ALL</option>
                      {issueCreatedOptions.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th className="issue-th-filter">
                  <div className="issue-th-with-filter">
                    <span>Status</span>
                    <select
                      value={issueStatusFilter}
                      title={issueStatusFilter || 'ALL'}
                      onChange={(e) => setIssueStatusFilter(e.target.value)}
                    >
                      <option value="">ALL</option>
                      <option value="Not Started">Not Started</option>
                      <option value="In Process">In Process</option>
                      <option value="Finished">Finished</option>
                    </select>
                  </div>
                </th>
                <th className="issue-th-filter">
                  <div className="issue-th-with-filter">
                    <span>Type</span>
                    <select
                      value={issueTypeFilter}
                      title={issueTypeFilter || 'ALL'}
                      onChange={(e) => setIssueTypeFilter(e.target.value)}
                    >
                      <option value="">ALL</option>
                      {issueTypeOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th className="issue-th-filter">
                  <div className="issue-th-with-filter">
                    <span>Submit</span>
                    <select
                      value={issueSubmitterFilter}
                      title={issueSubmitterFilter || 'ALL'}
                      onChange={(e) => setIssueSubmitterFilter(e.target.value)}
                    >
                      <option value="">ALL</option>
                      {issueSubmitterOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th>Issue</th>
                <th className="issue-th-date issue-th-filter">
                  <div className="issue-th-with-sort-and-filter">
                    <button
                      type="button"
                      className="issue-th-sort-btn issue-th-sort-btn--center issue-th-sort-btn--inrow"
                      onClick={() => toggleIssueDateSort('due_date')}
                    >
                      Due Date
                      {issueDateSort?.key === 'due_date' ? (issueDateSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                    <select
                      className="issue-th-head-select"
                      value={issueDueDateFilter}
                      title={issueDueDateFilter || 'ALL'}
                      onChange={(e) => setIssueDueDateFilter(e.target.value)}
                    >
                      <option value="">ALL</option>
                      {issueDueDateOptions.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th className="issue-th-filter">
                  <div className="issue-th-with-filter">
                    <span>PIC</span>
                    <select
                      value={issuePicFilter}
                      title={issuePicFilter || 'ALL'}
                      onChange={(e) => setIssuePicFilter(e.target.value)}
                    >
                      <option value="">ALL</option>
                      {issuePicOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>
                </th>
                <th>Progress</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedFilteredIssues.length === 0 ? (
                <tr>
                  <td colSpan={10} className="issue-empty-row">
                    {activeIssues.length === 0 ? 'No issues yet. Click Add Issue.' : 'No issues match current filters.'}
                  </td>
                </tr>
              ) : (
                sortedFilteredIssues.map((item, idx) => (
                  <tr key={item.id} className={item.status === 'Finished' ? 'issue-row-finished' : ''}>
                    <td>{idx + 1}</td>
                    <td className="issue-td-date">
                      <input
                        type="date"
                        className="issue-input-date"
                        lang="en-CA"
                        value={item.created_on}
                        onChange={(e) => updateIssue(item.id, 'created_on', e.target.value)}
                      />
                    </td>
                    <td>
                      <select value={item.status} onChange={(e) => updateIssue(item.id, 'status', e.target.value)}>
                        <option value="">Select...</option>
                        <option value="Not Started">Not Started</option>
                        <option value="In Process">In Process</option>
                        <option value="Finished">Finished</option>
                      </select>
                    </td>
                    <td>
                      <input value={item.type} onChange={(e) => updateIssue(item.id, 'type', e.target.value)} />
                    </td>
                    <td>
                      <input value={item.issued_by} onChange={(e) => updateIssue(item.id, 'issued_by', e.target.value)} />
                    </td>
                    <td className="issue-td-fill">
                      <IssueMultilineTextarea
                        className="issue-textarea-fill"
                        value={item.issue}
                        onChange={(e) => updateIssue(item.id, 'issue', e.target.value)}
                      />
                    </td>
                    <td className="issue-td-date">
                      <input
                        type="date"
                        className="issue-input-date"
                        lang="en-CA"
                        value={item.due_date}
                        onChange={(e) => updateIssue(item.id, 'due_date', e.target.value)}
                      />
                    </td>
                    <td>
                      <input value={item.pic} onChange={(e) => updateIssue(item.id, 'pic', e.target.value)} />
                    </td>
                    <td className="issue-td-fill">
                      <IssueMultilineTextarea
                        className="issue-textarea-fill"
                        value={item.progress}
                        onChange={(e) => updateIssue(item.id, 'progress', e.target.value)}
                      />
                    </td>
                    <td>
                      <div className="mom-action-cell">
                        <button
                          type="button"
                          onClick={() => moveIssue(item.id, 'up')}
                          disabled={activeIssues.findIndex((issue) => issue.id === item.id) <= 0}
                        >
                          Up
                        </button>
                        <button
                          type="button"
                          onClick={() => moveIssue(item.id, 'down')}
                          disabled={activeIssues.findIndex((issue) => issue.id === item.id) >= activeIssues.length - 1}
                        >
                          Down
                        </button>
                        <button type="button" className="danger" onClick={() => removeIssue(item.id)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className={`mom-panel ${activeMenu === 'mom' ? '' : 'section-hidden'}`}>
        <div className="mom-header">
          <h2>MOM</h2>
          <TabHeaderProjectPickers
            projectName={projectName}
            onProjectNameChange={setProjectName}
            companyFilter={companyFilter}
            onCompanyFilterChange={setCompanyFilter}
            filteredProjectNames={filteredProjectNames}
            distinctCompaniesForFilter={distinctCompaniesForFilter}
          />
          <span className="wbs-current-project issue-current-project" title={wbsTreeHeaderCaption}>
            {wbsTreeHeaderCaption}
          </span>
          <div className="mom-doc-controls">
            <button type="button" onClick={newMom} disabled={!projectName}>
              New MOM
            </button>
            <button type="button" className="danger" onClick={removeActiveMom} disabled={!projectName || !activeMomDoc}>
              Delete MOM
            </button>
            <label className="mom-date-select-wrap">
              Date
              <select
                value={activeMomDoc?.id ?? ''}
                onChange={(e) => {
                  if (!projectName) return
                  setSelectedMomIdByProject((current) => ({
                    ...current,
                    [projectName]: e.target.value ? Number(e.target.value) : null,
                  }))
                }}
                disabled={!projectName || momDocs.length === 0}
              >
                {momDocs.length === 0 ? (
                  <option value="">No MOM</option>
                ) : (
                  momDocs.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.header.date || '(No Date)'}
                    </option>
                  ))
                )}
              </select>
            </label>
          </div>
        </div>
        <div className="mom-header-fields">
          <label>
            Title
            <input value={activeMomHeader.title} onChange={(e) => updateProjectMomHeader('title', e.target.value)} />
          </label>
          <label>
            Date
            <input type="date" value={activeMomHeader.date} onChange={(e) => updateProjectMomHeader('date', e.target.value)} />
          </label>
          <label>
            Time
            <input value={activeMomHeader.time} onChange={(e) => updateProjectMomHeader('time', e.target.value)} />
          </label>
          <label>
            Attendance
            <input
              value={activeMomHeader.attendance}
              onChange={(e) => updateProjectMomHeader('attendance', e.target.value)}
            />
          </label>
          <label>
            Location
            <input value={activeMomHeader.location} onChange={(e) => updateProjectMomHeader('location', e.target.value)} />
          </label>
          <div className="mom-actions">
            <button type="button" onClick={addMomRow} disabled={!projectName || !activeMomDoc}>
              Add Row
            </button>
          </div>
        </div>
        <div className="mom-table-wrap">
          <table className="mom-table">
            <colgroup>
              <col className="mom-col-no" />
              <col className="mom-col-type" />
              <col className="mom-col-content" />
              <col className="mom-col-issue-no" />
              <col className="mom-col-remarks" />
              <col className="mom-col-pic" />
              <col className="mom-col-due" />
              <col className="mom-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th>No</th>
                <th>Type</th>
                <th>Topic</th>
                <th>Issue No</th>
                <th>Content</th>
                <th>PIC</th>
                <th>Due Date</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {activeMomItems.length === 0 ? (
                <tr>
                  <td colSpan={8} className="mom-empty-row">
                    No MOM rows yet. Click Add Row.
                  </td>
                </tr>
              ) : (
                activeMomItems.map((item, idx) => (
                  <tr key={item.id} className={item.type === 'New Issue' ? 'mom-row-new' : ''}>
                    <td>{idx + 1}</td>
                    <td>
                      <select value={item.type} onChange={(e) => updateMomItem(item.id, 'type', e.target.value)}>
                        <option value="">Select...</option>
                        <option value="New Issue">New Issue</option>
                      </select>
                    </td>
                    <td>
                      <IssueMultilineTextarea
                        className="mom-textarea-auto"
                        value={item.content}
                        onChange={(e) => updateMomItem(item.id, 'content', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        value={item.issue_list_no}
                        onChange={(e) => updateMomItem(item.id, 'issue_list_no', e.target.value)}
                      />
                    </td>
                    <td>
                      <IssueMultilineTextarea
                        className="mom-textarea-auto"
                        value={item.remarks}
                        onChange={(e) => updateMomItem(item.id, 'remarks', e.target.value)}
                      />
                    </td>
                    <td>
                      <input value={item.pic} onChange={(e) => updateMomItem(item.id, 'pic', e.target.value)} />
                    </td>
                    <td>
                      <input type="date" value={item.due_date} onChange={(e) => updateMomItem(item.id, 'due_date', e.target.value)} />
                    </td>
                    <td>
                      <div className="mom-action-cell">
                        <button type="button" onClick={() => moveMomItem(item.id, 'up')} disabled={idx === 0}>
                          Up
                        </button>
                        <button
                          type="button"
                          onClick={() => moveMomItem(item.id, 'down')}
                          disabled={idx === activeMomItems.length - 1}
                        >
                          Down
                        </button>
                        <button type="button" className="danger" onClick={() => removeMomItem(item.id)}>
                          Delete
                        </button>
                        {item.type === 'New Issue' ? (
                          <button
                            type="button"
                            className="mom-copy-issue-btn"
                            onClick={() => copyMomItemToIssueList(item)}
                          >
                            Copy to List
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className={`system-overview-panel ${activeMenu === 'system_overview' ? '' : 'section-hidden'}`}>
        <div className="system-overview-header">
          <h2>Overview</h2>
          <TabHeaderProjectPickers
            projectName={projectName}
            onProjectNameChange={setProjectName}
            companyFilter={companyFilter}
            onCompanyFilterChange={setCompanyFilter}
            filteredProjectNames={filteredProjectNames}
            distinctCompaniesForFilter={distinctCompaniesForFilter}
          />
          <span className="wbs-current-project issue-current-project" title={wbsTreeHeaderCaption}>
            {wbsTreeHeaderCaption}
          </span>
          <button type="button" onClick={addSystemOverviewItem} disabled={!projectName}>
            Add Item
          </button>
        </div>
        {activeSystemOverviewItems.length === 0 ? (
          <div className="system-overview-empty">No items yet. Click Add Item.</div>
        ) : (
          <div className="system-overview-list">
            {activeSystemOverviewItems.map((item, idx) => (
              (() => {
                const itemZoom = overviewImageZoomById[item.id] ?? 50
                return (
              <article className="system-overview-card" key={item.id}>
                <div className="system-overview-card-head">
                  <input
                    type="text"
                    className="system-overview-title-input"
                    value={item.title}
                    onChange={(event) => updateSystemOverviewItem(item.id, 'title', event.target.value)}
                    placeholder={`Item ${idx + 1}`}
                  />
                  <div className="system-overview-card-actions">
                    <button
                      type="button"
                      onClick={() => moveSystemOverviewItem(item.id, 'up')}
                      disabled={idx === 0}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      onClick={() => moveSystemOverviewItem(item.id, 'down')}
                      disabled={idx === activeSystemOverviewItems.length - 1}
                    >
                      Down
                    </button>
                    <button type="button" className="danger" onClick={() => removeSystemOverviewItem(item.id)}>
                      Delete
                    </button>
                  </div>
                </div>
                <div className="system-overview-image-block">
                  <div className="system-overview-image-controls">
                    <input
                      id={`overview-image-input-${item.id}`}
                      className="system-overview-file-input"
                      type="file"
                      accept="image/*"
                      onChange={(event) => handleSystemOverviewImageSelect(item.id, event.target.files?.[0] ?? null)}
                    />
                    <label htmlFor={`overview-image-input-${item.id}`} className="system-overview-file-btn">
                      Select Image
                    </label>
                    <div className="system-overview-zoom">
                      <span>Zoom {itemZoom}%</span>
                      <input
                        type="range"
                        min={50}
                        max={200}
                        step={10}
                        value={itemZoom}
                        onChange={(event) =>
                          setOverviewImageZoomById((current) => ({ ...current, [item.id]: Number(event.target.value) }))
                        }
                        aria-label={`Overview image zoom for item ${idx + 1}`}
                      />
                    </div>
                  </div>
                  {item.image_data_url ? (
                    <img
                      src={item.image_data_url}
                      alt={`System overview ${idx + 1}`}
                      className="system-overview-image"
                      style={{ width: `${itemZoom}%`, maxWidth: 'none', maxHeight: 'none' }}
                    />
                  ) : (
                    <div className="system-overview-image-placeholder">No image uploaded</div>
                  )}
                </div>
                <label className="system-overview-description">
                  <IssueMultilineTextarea
                    value={item.description}
                    onChange={(event) => updateSystemOverviewItem(item.id, 'description', event.target.value)}
                    placeholder="Write description for this image..."
                  />
                </label>
              </article>
                )
              })()
            ))}
          </div>
        )}
      </section>

      <section className={`editor ${activeMenu === 'wbs' ? '' : 'section-hidden'}`}>
        <h2>Progress Update</h2>
        {selectedTask ? (
          <>
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
                  title={
                    hasChildren
                      ? '子がすべて「数値+MH」または「数値+MD」（例: 10MH, 8.5 MD）のときだけ合計表示されます（編集は子で行ってください）'
                      : undefined
                  }
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
                  <option value="In Process">In Process</option>
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
          </>
        ) : (
          <div className="actions">
            <button type="button" onClick={() => addTask(null)} disabled={!projectName}>
              Add First Task
            </button>
          </div>
        )}
      </section>

      <footer className="app-footer">WBS Viewer v1.0 powered by PT.BAHTERA HISISTEM INDONESIA</footer>
    </main>
  )
}

export default App
