export type BackupFileGroup = {
  driver: string
  count: number
  bytes: number
  error?: string
}

export type BackupRestoreStatus =
  | "uploading"
  | "validating"
  | "ready"
  | "invalid"
  | "restoring"
  | "completed"
  | "failed"

export type BackupRestoreProgress = {
  phase?: "database" | "constraints" | "files" | "done"
  currentTable?: string
  tablesDone?: number
  tablesTotal?: number
  rowsDone?: number
  rowsTotal?: number
  filesDone?: number
  filesTotal?: number
  bytesDone?: number
  bytesTotal?: number
}

export type BackupSummary = {
  createdAt: string
  createdBy: string
  schema: "current" | "older"
  tables: number
  rows: number
  includesFiles: boolean
  files: BackupFileGroup[]
  fileCount: number
  fileBytes: number
  encryptionKeyMatches: boolean
  newerMigrations: number
}

export type BackupWarning = {
  code: string
  message: string
  values?: Record<string, string | number>
}

/** English source messages for server warning codes; translated in the UI. */
export const backupWarningMessages: Record<string, string> = {
  older_schema:
    "The backup was created by an older JustAI version ({count} newer migrations here). Columns added since then get their defaults; data conversions from those upgrades are not repeated.",
  encryption_key_mismatch:
    "This instance uses a different encryption key. Stored provider credentials, MCP secrets, and recordings from the backup cannot be decrypted until JUSTAI_ENCRYPTION_KEY matches the original instance.",
  table_removed: "Table {table} no longer exists; its {rows} rows are skipped.",
  columns_removed:
    "Table {table}: columns {columns} no longer exist and are skipped.",
  no_files:
    "The backup contains no stored files. Recordings and uploaded videos must already exist in this instance's storage, or they will be missing.",
}

export type BackupRestoreJob = {
  id: string
  status: BackupRestoreStatus
  fileName: string
  expectedBytes: number
  receivedBytes: number
  createdBy: string
  summary: BackupSummary | Record<string, never> | null
  warnings: BackupWarning[]
  progress: BackupRestoreProgress
  error?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
}

export type BackupOverview = {
  database: { bytes: number; estimatedRows: number; tables: number }
  storageDriver: string
  files: BackupFileGroup[]
  excludedTables: string[]
  chunkBytes: number
  restoreConfirm: string
  restores: BackupRestoreJob[]
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"]

export function formatBackupBytes(value: number, locale = "en") {
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  let unit = 0
  let amount = value
  while (amount >= 1024 && unit < BYTE_UNITS.length - 1) {
    amount /= 1024
    unit += 1
  }
  const digits = unit === 0 || amount >= 100 ? 0 : 1
  return `${amount.toLocaleString(locale, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })} ${BYTE_UNITS[unit]}`
}

/** Byte ranges for a chunked upload; the server requires this exact order. */
export function backupChunkRanges(size: number, chunkBytes: number) {
  if (size <= 0 || chunkBytes <= 0) return []
  const ranges: Array<{ offset: number; end: number }> = []
  for (let offset = 0; offset < size; offset += chunkBytes) {
    ranges.push({ offset, end: Math.min(size, offset + chunkBytes) })
  }
  return ranges
}

function ratio(done = 0, total = 0) {
  if (total <= 0) return 1
  return Math.min(1, Math.max(0, done / total))
}

/**
 * One progress value across the restore phases. Rows dominate when there are
 * no files; with files, copying them is weighted by bytes.
 */
export function backupRestorePercent(progress: BackupRestoreProgress) {
  if (progress.phase === "done") return 100
  const hasFiles = (progress.bytesTotal ?? 0) > 0
  const databaseShare = hasFiles ? 0.5 : 0.95
  const rows = ratio(progress.rowsDone, progress.rowsTotal)
  let value = 0
  if (!progress.phase || progress.phase === "database") {
    value = rows * databaseShare * 0.9
  } else if (progress.phase === "constraints") {
    value = databaseShare * 0.9
  } else if (progress.phase === "files") {
    value =
      databaseShare +
      ratio(progress.bytesDone, progress.bytesTotal) * (1 - databaseShare)
  }
  return Math.min(99, Math.round(value * 100))
}

export function backupRestoreIsActive(status: BackupRestoreStatus) {
  return (
    status === "uploading" || status === "validating" || status === "restoring"
  )
}

/** A restore replaces the admin's session; its token lets the page follow it. */
export const BACKUP_RESTORE_STORAGE_KEY = "justai.backupRestore"

export type StoredBackupRestore = { id: string; token: string }

export function parseStoredBackupRestore(
  value: string | null
): StoredBackupRestore | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<StoredBackupRestore>
    if (
      typeof parsed.id === "string" &&
      /^[0-9a-f-]{36}$/i.test(parsed.id) &&
      typeof parsed.token === "string" &&
      parsed.token.length >= 32
    ) {
      return { id: parsed.id, token: parsed.token }
    }
  } catch {
    // Ignore damaged browser storage.
  }
  return null
}

export function backupExportPath(includeFiles: boolean) {
  return `/api/v1/admin/backup/export?files=${includeFiles ? "true" : "false"}`
}

/** Whether a picked file can continue a paused upload. */
export function backupResumeMatches(
  job: Pick<BackupRestoreJob, "fileName" | "expectedBytes">,
  file: { name: string; size: number }
) {
  return job.fileName === file.name && job.expectedBytes === file.size
}

/**
 * Where a paused upload continues. The server only accepts chunk-aligned
 * offsets, so a partial chunk is sent again.
 */
export function backupResumeOffset(receivedBytes: number, chunkBytes: number) {
  if (receivedBytes <= 0 || chunkBytes <= 0) return 0
  return Math.floor(receivedBytes / chunkBytes) * chunkBytes
}

/** The offset the server reported after rejecting an out-of-order chunk. */
export function backupConflictOffset(details: unknown) {
  if (!details || typeof details !== "object") return null
  const value = (details as { receivedBytes?: unknown }).receivedBytes
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}
