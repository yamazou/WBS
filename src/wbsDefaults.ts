export type TaskStatus = 'Not Started' | 'On process' | 'Finished'
export type ZoomUnit = 'day' | 'week' | 'month'

export type Task = {
  id: number
  name: string
  parent_id: number | null
  order: number
  planned_start_date: string
  planned_end_date: string
  actual_start_date: string
  actual_end_date: string
  role: string
  status: TaskStatus
  progress: number
  /** Free text e.g. `8 MD` on Gantt / tree; parents with children show rollup sum in UI. */
  mh_md: string
}

export type ProjectBundle = {
  tasks: Task[]
  company: string
  /** ISO `YYYY-MM-DD` for PO Date (optional). */
  po_date: string
}

export function emptyProjectBundle(tasks: Task[] = []): ProjectBundle {
  return { tasks, company: '', po_date: '' }
}

export const initialTasks: Task[] = [
  {
    id: 1,
    name: 'プロジェクト管理システム',
    parent_id: null,
    order: 1,
    planned_start_date: '2026-05-01',
    planned_end_date: '2026-08-31',
    actual_start_date: '2026-05-01',
    actual_end_date: '',
    role: 'Internal',
    status: 'On process',
    progress: 35,
    mh_md: '',
  },
  {
    id: 2,
    name: '要件定義',
    parent_id: 1,
    order: 1,
    planned_start_date: '2026-05-01',
    planned_end_date: '2026-05-05',
    actual_start_date: '2026-05-01',
    actual_end_date: '2026-05-04',
    role: 'Customer',
    status: 'Finished',
    progress: 100,
    mh_md: '',
  },
  {
    id: 3,
    name: 'UI設計',
    parent_id: 1,
    order: 2,
    planned_start_date: '2026-05-06',
    planned_end_date: '2026-05-12',
    actual_start_date: '2026-05-07',
    actual_end_date: '',
    role: 'Internal',
    status: 'On process',
    progress: 60,
    mh_md: '',
  },
  {
    id: 4,
    name: 'WBSツリー実装',
    parent_id: 1,
    order: 3,
    planned_start_date: '2026-05-13',
    planned_end_date: '2026-05-20',
    actual_start_date: '2026-05-14',
    actual_end_date: '',
    role: 'Internal',
    status: 'On process',
    progress: 40,
    mh_md: '',
  },
  {
    id: 5,
    name: 'ガント表示実装',
    parent_id: 1,
    order: 4,
    planned_start_date: '2026-05-16',
    planned_end_date: '2026-05-24',
    actual_start_date: '',
    actual_end_date: '',
    role: 'Customer',
    status: 'Not Started',
    progress: 0,
    mh_md: '',
  },
  {
    id: 6,
    name: '進捗更新機能',
    parent_id: 1,
    order: 5,
    planned_start_date: '2026-05-22',
    planned_end_date: '2026-05-28',
    actual_start_date: '',
    actual_end_date: '',
    role: 'Internal',
    status: 'Not Started',
    progress: 0,
    mh_md: '',
  },
]

const blankSchedule: Pick<
  Task,
  'planned_start_date' | 'planned_end_date' | 'actual_start_date' | 'actual_end_date' | 'role' | 'status' | 'progress' | 'mh_md'
> = {
  planned_start_date: '',
  planned_end_date: '',
  actual_start_date: '',
  actual_end_date: '',
  role: '',
  status: 'Not Started',
  progress: 0,
  mh_md: '',
}

/** 新規プロジェクト作成時に task テーブルへ入れるデフォルト WBS（Overall 配下に7フェーズ）。日付・ロールは未入力。 */
export const NEW_PROJECT_DEFAULT_TASKS: Task[] = [
  { id: 1, name: 'Overall', parent_id: null, order: 1, ...blankSchedule },
  { id: 2, name: 'Preparation', parent_id: 1, order: 1, ...blankSchedule },
  { id: 3, name: 'User Requirement', parent_id: 1, order: 2, ...blankSchedule },
  { id: 4, name: 'Design', parent_id: 1, order: 3, ...blankSchedule },
  { id: 5, name: 'Development', parent_id: 1, order: 4, ...blankSchedule },
  { id: 6, name: 'Test', parent_id: 1, order: 5, ...blankSchedule },
  { id: 7, name: 'UAT', parent_id: 1, order: 6, ...blankSchedule },
  { id: 8, name: 'Go Live Support', parent_id: 1, order: 7, ...blankSchedule },
]
