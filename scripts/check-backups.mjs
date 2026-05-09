import fs from 'node:fs'
import path from 'node:path'
import initSqlJs from 'sql.js/dist/sql-asm.js'

const root = process.cwd()
const dataDir = path.join(root, '.wbs-data')
const dbFile = path.join(dataDir, 'wbs.db')
const backupsDir = path.join(dataDir, 'backups')

const SQL = await initSqlJs()

function inspect(filePath) {
  const name = path.basename(filePath)
  const size = fs.statSync(filePath).size
  try {
    const bytes = fs.readFileSync(filePath)
    const db = new SQL.Database(bytes)
    const c = db.exec('SELECT COUNT(*) AS c FROM projects')
    const projects = Number(c?.[0]?.values?.[0]?.[0] ?? 0)
    db.close()
    return { name, size, ok: true, projects, error: '' }
  } catch (e) {
    return { name, size, ok: false, projects: -1, error: e instanceof Error ? e.message : String(e) }
  }
}

const targets = []
if (fs.existsSync(dbFile)) targets.push(dbFile)
if (fs.existsSync(backupsDir)) {
  for (const n of fs.readdirSync(backupsDir).filter((x) => x.endsWith('.db')).sort().reverse()) {
    targets.push(path.join(backupsDir, n))
  }
}

for (const f of targets) {
  const r = inspect(f)
  if (r.ok) {
    console.log(`OK  ${r.name} size=${r.size} projects=${r.projects}`)
  } else {
    console.log(`NG  ${r.name} size=${r.size} error=${r.error}`)
  }
}
