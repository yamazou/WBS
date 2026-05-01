/** Shared DDL for WBS SQLite (Vite seed + runtime ensureSchema). */
export const WBS_DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  company TEXT NOT NULL DEFAULT '',
  po_date TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  project_name TEXT NOT NULL,
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  parent_id INTEGER,
  task_order INTEGER NOT NULL,
  planned_start_date TEXT NOT NULL,
  planned_end_date TEXT NOT NULL,
  actual_start_date TEXT NOT NULL,
  actual_end_date TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL,
  mh_md TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_name, id),
  FOREIGN KEY (project_name) REFERENCES projects(name) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS companies (
  name TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
`
