"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  CheckCircle2,
  Download,
  FileArchive,
  Pause,
  Play,
  RotateCcw,
  Upload,
  X,
} from "lucide-react"

import { useTranslations } from "@/components/locale-provider"
import { Alert } from "@/components/panelui/alert"
import { Badge } from "@/components/panelui/badge"
import { Button } from "@/components/panelui/button"
import { Field } from "@/components/panelui/field"
import { Frame } from "@/components/panelui/frame"
import { Input } from "@/components/panelui/input"
import { Spinner } from "@/components/panelui/spinner"
import { Switch } from "@/components/panelui/switch"
import { Progress } from "@/components/ui/progress"
import { APIError, api, resolveAPIURL } from "@/lib/api"
import { feedbackMessage } from "@/lib/feedback"
import {
  BACKUP_RESTORE_STORAGE_KEY,
  backupConflictOffset,
  backupResumeMatches,
  backupResumeOffset,
  backupExportPath,
  backupRestoreIsActive,
  backupRestorePercent,
  backupWarningMessages,
  formatBackupBytes,
  parseStoredBackupRestore,
  type BackupOverview,
  type BackupRestoreJob,
  type BackupRestoreProgress,
  type BackupRestoreStatus,
  type BackupSummary,
  type StoredBackupRestore,
} from "@/lib/platform-backup"

const POLL_MS = 1500
const CHUNK_TIMEOUT_MS = 5 * 60_000
const CHUNK_ATTEMPTS = 4

type RestoreStatusResponse = {
  restore: {
    id: string
    status: BackupRestoreStatus
    progress: BackupRestoreProgress
    error?: string
  }
}

function readStoredRestore() {
  try {
    return parseStoredBackupRestore(
      window.sessionStorage.getItem(BACKUP_RESTORE_STORAGE_KEY)
    )
  } catch {
    return null
  }
}

function writeStoredRestore(value: StoredBackupRestore | null) {
  try {
    if (value) {
      window.sessionStorage.setItem(
        BACKUP_RESTORE_STORAGE_KEY,
        JSON.stringify(value)
      )
    } else {
      window.sessionStorage.removeItem(BACKUP_RESTORE_STORAGE_KEY)
    }
  } catch {
    // Without storage the page still follows the restore until it reloads.
  }
}

function isSummary(value: BackupRestoreJob["summary"]): value is BackupSummary {
  return Boolean(value && "createdAt" in value)
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function PlatformBackupView() {
  const { t, locale } = useTranslations()
  const [overview, setOverview] = useState<BackupOverview | null>(null)
  const [loadError, setLoadError] = useState("")
  const [includeFiles, setIncludeFiles] = useState(true)
  const [job, setJob] = useState<BackupRestoreJob | null>(null)
  const [uploadedBytes, setUploadedBytes] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [actionError, setActionError] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [starting, setStarting] = useState(false)
  const [restore, setRestore] = useState<StoredBackupRestore | null>(null)
  const [restoreStatus, setRestoreStatus] = useState<
    RestoreStatusResponse["restore"] | null
  >(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadAbort = useRef<AbortController | null>(null)
  // The paused upload a picked file continues, if any.
  const resumeTarget = useRef<BackupRestoreJob | null>(null)

  const bytes = useCallback(
    (value: number) => formatBackupBytes(value, locale),
    [locale]
  )
  const number = useCallback(
    (value: number) => value.toLocaleString(locale),
    [locale]
  )
  const date = useCallback(
    (value?: string) =>
      value
        ? new Date(value).toLocaleString(locale, {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : "",
    [locale]
  )

  const loadOverview = useCallback(async () => {
    try {
      const result = await api.get<BackupOverview>("/api/v1/admin/backup")
      setOverview(result)
      setLoadError("")
      return result
    } catch (caught) {
      setLoadError(
        feedbackMessage(caught, "Backup information could not be loaded.")
      )
      return null
    }
  }, [])

  useEffect(() => {
    const stored = readStoredRestore()
    const timer = window.setTimeout(() => {
      if (stored) setRestore(stored)
      void loadOverview().then((result) => {
        // Pick up a staged backup that is still waiting for a decision.
        const pending = result?.restores.find(
          (item) =>
            item.status === "uploading" ||
            item.status === "validating" ||
            item.status === "ready" ||
            item.status === "invalid"
        )
        if (pending && !stored) {
          setJob(pending)
          setUploadedBytes(pending.receivedBytes)
        }
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadOverview])

  // Closing the tab pauses the upload; ask first.
  useEffect(() => {
    if (!uploading) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [uploading])

  // Follow validation with the admin endpoint.
  useEffect(() => {
    if (!job || job.status !== "validating") return
    const timer = window.setInterval(async () => {
      try {
        const result = await api.get<{ restore: BackupRestoreJob }>(
          `/api/v1/admin/backup/restores/${job.id}`
        )
        setJob(result.restore)
      } catch (caught) {
        setActionError(
          feedbackMessage(caught, "The backup check could not be followed.")
        )
      }
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [job])

  // Follow a running restore with its token: it replaces this session.
  useEffect(() => {
    if (!restore) return
    let cancelled = false
    let timer = 0
    const poll = async () => {
      try {
        const result = await api.get<RestoreStatusResponse>(
          `/api/v1/backup-restores/${restore.id}/status`,
          { headers: { "X-Restore-Token": restore.token } }
        )
        if (cancelled) return
        setRestoreStatus(result.restore)
        if (backupRestoreIsActive(result.restore.status)) {
          timer = window.setTimeout(() => void poll(), POLL_MS)
        } else if (result.restore.status !== "completed") {
          writeStoredRestore(null)
        }
      } catch (caught) {
        if (cancelled) return
        if (caught instanceof APIError && caught.status === 404) {
          writeStoredRestore(null)
          setRestore(null)
          setRestoreStatus(null)
          return
        }
        // The backend may be restarting; keep trying.
        timer = window.setTimeout(() => void poll(), POLL_MS * 2)
      }
    }
    void poll()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [restore])

  function downloadBackup() {
    const anchor = document.createElement("a")
    anchor.href = resolveAPIURL(backupExportPath(includeFiles))
    anchor.download = ""
    anchor.rel = "noopener"
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  }

  function chooseFile(resume: BackupRestoreJob | null) {
    resumeTarget.current = resume
    fileInput.current?.click()
  }

  /**
   * Sends the file in chunks. A paused or failed upload keeps everything the
   * server already received and continues from there with the same file.
   */
  async function uploadBackup(file: File, resume: BackupRestoreJob | null) {
    if (!overview) return
    setActionError("")
    setConfirmation("")
    if (resume && !backupResumeMatches(resume, file)) {
      setActionError(
        t(
          "This is a different file. Choose {name} ({size}) to continue, or discard the paused upload.",
          { name: resume.fileName, size: bytes(resume.expectedBytes) }
        )
      )
      return
    }
    setUploading(true)
    const controller = new AbortController()
    uploadAbort.current = controller
    let current: BackupRestoreJob | null = null
    let offset = 0
    let chunkBytes = overview.chunkBytes
    try {
      if (resume) {
        const result = await api.get<{ restore: BackupRestoreJob }>(
          `/api/v1/admin/backup/restores/${resume.id}`
        )
        current = result.restore
        if (current.status !== "uploading") {
          setJob(current)
          return
        }
        offset = backupResumeOffset(current.receivedBytes, chunkBytes)
      } else {
        setUploadedBytes(0)
        const result = await api.post<{
          restore: BackupRestoreJob
          chunkBytes: number
        }>("/api/v1/admin/backup/restores", {
          fileName: file.name,
          size: file.size,
        })
        current = result.restore
        chunkBytes = result.chunkBytes
      }
      setJob(current)
      setUploadedBytes(offset)
      const jobId = current.id
      while (offset < file.size) {
        const end = Math.min(file.size, offset + chunkBytes)
        for (let attempt = 1; ; attempt++) {
          try {
            const response = await api.binary<{ restore: BackupRestoreJob }>(
              `/api/v1/admin/backup/restores/${jobId}/chunks?offset=${offset}`,
              file.slice(offset, end),
              "PUT",
              { signal: controller.signal, timeoutMs: CHUNK_TIMEOUT_MS }
            )
            current = response.restore
            offset = end
            break
          } catch (caught) {
            // A lost response can leave the server ahead of this page.
            const serverOffset =
              caught instanceof APIError && caught.status === 409
                ? backupConflictOffset(caught.details)
                : null
            if (serverOffset !== null) {
              offset = backupResumeOffset(serverOffset, chunkBytes)
              break
            }
            const retryable =
              caught instanceof APIError &&
              (caught.status === 0 ||
                caught.status === 408 ||
                caught.status >= 500)
            if (!retryable || attempt >= CHUNK_ATTEMPTS) throw caught
            await wait(1000 * 2 ** attempt)
          }
        }
        setUploadedBytes(offset)
      }
      setJob(current)
    } catch (caught) {
      if (caught instanceof APIError && caught.status === 404) {
        setJob(null)
        setActionError(
          t("The paused upload no longer exists. Upload the backup again.")
        )
      } else if (caught instanceof APIError && caught.status === 410) {
        // The staged file is gone, e.g. the backend restarted with a cleared
        // temp directory; only a fresh upload can help.
        if (current) {
          void api
            .delete(`/api/v1/admin/backup/restores/${current.id}`)
            .catch(() => undefined)
        }
        setJob(null)
        setActionError(
          t(
            "The backend no longer has the uploaded part. Upload the backup again."
          )
        )
      } else {
        if (current) {
          setJob({ ...current, status: "uploading", receivedBytes: offset })
        }
        if (!(caught instanceof APIError && caught.status === 499)) {
          setActionError(
            t(
              "The upload paused at {done} of {total}: {reason} Choose the same file to continue.",
              {
                done: bytes(offset),
                total: bytes(file.size),
                reason: t(
                  feedbackMessage(caught, "The backup could not be uploaded.")
                ),
              }
            )
          )
        }
      }
    } finally {
      uploadAbort.current = null
      resumeTarget.current = null
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }

  async function discardBackup() {
    if (!job) return
    setActionError("")
    try {
      await api.delete(`/api/v1/admin/backup/restores/${job.id}`)
      setJob(null)
      setUploadedBytes(0)
      setConfirmation("")
      void loadOverview()
    } catch (caught) {
      setActionError(
        feedbackMessage(caught, "The staged backup could not be discarded.")
      )
    }
  }

  async function startRestore() {
    if (!job || !overview) return
    setStarting(true)
    setActionError("")
    try {
      const result = await api.post<{
        restore: BackupRestoreJob
        statusToken: string
      }>(`/api/v1/admin/backup/restores/${job.id}/start`, { confirmation })
      const stored = { id: job.id, token: result.statusToken }
      writeStoredRestore(stored)
      setRestoreStatus({
        id: job.id,
        status: "restoring",
        progress: { phase: "database" },
      })
      setRestore(stored)
      setJob(null)
      setConfirmation("")
    } catch (caught) {
      setActionError(
        feedbackMessage(caught, "The restore could not be started.")
      )
    } finally {
      setStarting(false)
    }
  }

  function finishRestore() {
    writeStoredRestore(null)
    // A full page load drops every cached workspace from the replaced data.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login")
  }

  function dismissRestore() {
    writeStoredRestore(null)
    setRestore(null)
    setRestoreStatus(null)
    void loadOverview()
  }

  const restoreActive = Boolean(
    restoreStatus && backupRestoreIsActive(restoreStatus.status)
  )
  const busy = uploading || starting || restoreActive
  const confirmWord = overview?.restoreConfirm ?? "RESTORE"
  const summary = job && isSummary(job.summary) ? job.summary : null
  const totalFiles =
    overview?.files.reduce((sum, item) => sum + item.count, 0) ?? 0
  const totalFileBytes =
    overview?.files.reduce((sum, item) => sum + item.bytes, 0) ?? 0
  const phaseLabel: Record<string, string> = {
    database: "Restoring database",
    constraints: "Checking relationships",
    files: "Copying stored files",
    done: "Finished",
  }

  return (
    <div className="flex flex-col gap-5">
      {loadError && (
        <Alert tone="destructive" variant="plain">
          <Alert.Title>{t("Backup information unavailable")}</Alert.Title>
          <Alert.Description>{t(loadError)}</Alert.Description>
          <Alert.Actions>
            <Button
              onClick={() => void loadOverview()}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("Retry")}
            </Button>
          </Alert.Actions>
        </Alert>
      )}

      <Frame aria-busy={!overview && !loadError}>
        <Frame.Header>
          <Frame.Title>{t("Create backup")}</Frame.Title>
          <Frame.Description>
            {t(
              "Download the whole instance as one ZIP archive: every workspace, user, chat, knowledge source, transcript, and setting."
            )}
          </Frame.Description>
          {!overview && !loadError && (
            <Frame.Action>
              <Spinner className="size-4" />
            </Frame.Action>
          )}
        </Frame.Header>
        <Frame.Panel>
          <Frame.Row className="flex-wrap gap-y-3">
            <Frame.Content className="min-w-48">
              <Frame.Title>{t("Database")}</Frame.Title>
              <Frame.Description className="overflow-visible! text-clip! whitespace-normal!">
                {overview
                  ? t("{size} in {tables} tables, about {rows} rows", {
                      size: bytes(overview.database.bytes),
                      tables: number(overview.database.tables),
                      rows: number(overview.database.estimatedRows),
                    })
                  : t("Loading…")}
              </Frame.Description>
            </Frame.Content>
            <Frame.Actions>
              <Badge variant="secondary">{t("Always included")}</Badge>
            </Frame.Actions>
          </Frame.Row>
          <Field disabled={!overview}>
            <Frame.Row className="flex-wrap gap-y-3">
              <Frame.Content className="min-w-48">
                <Field.Label>{t("Include stored files")}</Field.Label>
                <Field.Description>
                  {overview
                    ? t(
                        "Recordings and uploaded videos: {count} files, {size}. Turn this off for a small database-only backup when the file storage is backed up separately.",
                        {
                          count: number(totalFiles),
                          size: bytes(totalFileBytes),
                        }
                      )
                    : t("Recordings and uploaded videos.")}
                </Field.Description>
                {overview?.files.some((item) => item.error) && (
                  <Field.Description className="text-destructive">
                    {t(
                      "Some stored files could not be listed. Check the storage configuration before relying on this backup."
                    )}
                  </Field.Description>
                )}
              </Frame.Content>
              <Frame.Actions>
                <Switch
                  size="sm"
                  aria-label={t("Include stored files")}
                  checked={includeFiles}
                  onCheckedChange={(checked) => setIncludeFiles(checked)}
                />
              </Frame.Actions>
            </Frame.Row>
          </Field>
        </Frame.Panel>
        <Frame.Footer className="flex flex-wrap items-center justify-between gap-3">
          <span className="max-w-xl text-xs text-muted-foreground">
            {t(
              "Sessions and one-time sign-in tokens are left out. Credentials stay encrypted: restoring needs the same JUSTAI_ENCRYPTION_KEY."
            )}
          </span>
          <Button
            disabled={!overview}
            onClick={downloadBackup}
            size="sm"
            type="button"
          >
            <Download data-icon="inline-start" />
            {t("Download backup")}
          </Button>
        </Frame.Footer>
      </Frame>

      <Frame>
        <Frame.Header>
          <Frame.Title>{t("Restore backup")}</Frame.Title>
          <Frame.Description>
            {t(
              "Replace all data on this instance with a backup. The backup is uploaded and checked first; nothing changes until you confirm."
            )}
          </Frame.Description>
        </Frame.Header>
        <Frame.Panel className="flex flex-col gap-4 p-4">
          <input
            ref={fileInput}
            accept=".zip,application/zip"
            aria-hidden="true"
            className="sr-only"
            id="backup-restore-file"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void uploadBackup(file, resumeTarget.current)
            }}
            tabIndex={-1}
            type="file"
          />
          {actionError && (
            <Alert tone="destructive" variant="plain">
              <Alert.Description>{t(actionError)}</Alert.Description>
            </Alert>
          )}

          {restore && restoreStatus ? (
            <RestoreProgressPanel
              status={restoreStatus}
              phaseLabel={phaseLabel}
              number={number}
              bytes={bytes}
              onFinish={finishRestore}
              onDismiss={dismissRestore}
            />
          ) : !job && !uploading ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {t("Choose a JustAI backup archive (.zip).")}
              </p>
              <Button
                disabled={!overview || busy}
                onClick={() => chooseFile(null)}
                size="sm"
                type="button"
                variant="outline"
              >
                <Upload data-icon="inline-start" />
                {t("Upload backup")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <FileArchive
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="truncate text-sm font-medium">
                    {job?.fileName || t("Backup")}
                  </span>
                  {job && <StatusBadge status={job.status} />}
                </div>
                <div className="flex flex-wrap gap-2">
                  {uploading ? (
                    <Button
                      onClick={() => uploadAbort.current?.abort()}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <Pause data-icon="inline-start" />
                      {t("Pause upload")}
                    </Button>
                  ) : (
                    job?.status === "uploading" && (
                      <Button
                        disabled={!overview}
                        onClick={() => chooseFile(job)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <Play data-icon="inline-start" />
                        {t("Continue upload")}
                      </Button>
                    )
                  )}
                  {!uploading && (
                    <Button
                      disabled={starting || job?.status === "validating"}
                      onClick={() => void discardBackup()}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <X data-icon="inline-start" />
                      {t("Discard")}
                    </Button>
                  )}
                </div>
              </div>

              {(uploading || job?.status === "uploading") && (
                <Progress
                  aria-label={t("Upload progress")}
                  value={
                    job?.expectedBytes
                      ? Math.round((uploadedBytes / job.expectedBytes) * 100)
                      : 0
                  }
                >
                  <span className="text-xs text-muted-foreground">
                    {t(
                      uploading
                        ? "Uploading {done} of {total}"
                        : "Paused at {done} of {total}. Choose the same file to continue; the uploaded part is kept for 24 hours.",
                      {
                        done: bytes(uploadedBytes),
                        total: bytes(job?.expectedBytes ?? 0),
                      }
                    )}
                  </span>
                </Progress>
              )}

              {job?.status === "validating" && (
                <p
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                  role="status"
                >
                  <Spinner className="size-4" />
                  {t(
                    "Checking every table and file in the backup. Large backups take a few minutes."
                  )}
                </p>
              )}

              {job?.status === "invalid" && (
                <Alert tone="destructive" variant="plain">
                  <Alert.Title>
                    {t("This backup cannot be restored")}
                  </Alert.Title>
                  <Alert.Description>{job.error}</Alert.Description>
                </Alert>
              )}

              {(job?.status === "ready" || job?.status === "failed") &&
                summary && (
                  <>
                    {job.status === "failed" && job.error && (
                      <Alert tone="destructive" variant="plain">
                        <Alert.Title>
                          {t("The last attempt failed")}
                        </Alert.Title>
                        <Alert.Description>{job.error}</Alert.Description>
                      </Alert>
                    )}
                    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                      <SummaryItem label={t("Created")}>
                        {date(summary.createdAt)}
                        {summary.createdBy ? ` · ${summary.createdBy}` : ""}
                      </SummaryItem>
                      <SummaryItem label={t("Version")}>
                        {summary.schema === "current"
                          ? t("Same as this instance")
                          : t("Older JustAI version")}
                      </SummaryItem>
                      <SummaryItem label={t("Database")}>
                        {t("{tables} tables, {rows} rows", {
                          tables: number(summary.tables),
                          rows: number(summary.rows),
                        })}
                      </SummaryItem>
                      <SummaryItem label={t("Stored files")}>
                        {summary.includesFiles
                          ? t("{count} files, {size}", {
                              count: number(summary.fileCount),
                              size: bytes(summary.fileBytes),
                            })
                          : t("Not included")}
                      </SummaryItem>
                    </dl>
                    {job.warnings.length > 0 && (
                      <Alert tone="warning" variant="plain">
                        <Alert.Title>{t("Before you restore")}</Alert.Title>
                        <Alert.Description>
                          <ul className="list-disc space-y-1 pl-4">
                            {job.warnings.map((warning) => (
                              <li key={`${warning.code}-${warning.message}`}>
                                {backupWarningMessages[warning.code]
                                  ? t(
                                      backupWarningMessages[warning.code],
                                      warning.values
                                    )
                                  : warning.message}
                              </li>
                            ))}
                          </ul>
                        </Alert.Description>
                      </Alert>
                    )}
                    <Alert tone="destructive" variant="plain">
                      <Alert.Title>
                        {t(
                          "Every current workspace, user, and chat is replaced"
                        )}
                      </Alert.Title>
                      <Alert.Description>
                        {t(
                          "All data on this instance is deleted and replaced by the backup. Everyone is signed out, including you. Stop transcriptions and agent runs first."
                        )}
                      </Alert.Description>
                    </Alert>
                    <Field disabled={starting}>
                      <Field.Label>
                        {t("Type {word} to confirm", { word: confirmWord })}
                      </Field.Label>
                      <div className="flex flex-wrap gap-2">
                        <Input
                          autoComplete="off"
                          className="max-w-56"
                          id="backup-restore-confirmation"
                          onChange={(event) =>
                            setConfirmation(event.target.value)
                          }
                          spellCheck={false}
                          value={confirmation}
                        />
                        <Button
                          disabled={
                            starting || confirmation.trim() !== confirmWord
                          }
                          onClick={() => void startRestore()}
                          size="sm"
                          type="button"
                          variant="destructive"
                        >
                          {starting ? (
                            <Spinner className="size-4" />
                          ) : (
                            <RotateCcw data-icon="inline-start" />
                          )}
                          {t("Restore backup")}
                        </Button>
                      </div>
                    </Field>
                  </>
                )}
            </div>
          )}
        </Frame.Panel>
      </Frame>
    </div>
  )
}

function SummaryItem({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  )
}

function StatusBadge({ status }: { status: BackupRestoreStatus }) {
  const { t } = useTranslations()
  const labels: Record<BackupRestoreStatus, string> = {
    uploading: "Uploading",
    validating: "Checking",
    ready: "Ready to restore",
    invalid: "Invalid",
    restoring: "Restoring",
    completed: "Restored",
    failed: "Failed",
  }
  const variant =
    status === "ready" || status === "completed"
      ? "success"
      : status === "invalid" || status === "failed"
        ? "destructive"
        : "secondary"
  return <Badge variant={variant}>{t(labels[status])}</Badge>
}

function RestoreProgressPanel({
  status,
  phaseLabel,
  number,
  bytes,
  onFinish,
  onDismiss,
}: {
  status: RestoreStatusResponse["restore"]
  phaseLabel: Record<string, string>
  number: (value: number) => string
  bytes: (value: number) => string
  onFinish: () => void
  onDismiss: () => void
}) {
  const { t } = useTranslations()
  const progress = status.progress ?? {}
  if (status.status === "completed") {
    return (
      <Alert tone="success" variant="plain">
        <Alert.Icon>
          <CheckCircle2 />
        </Alert.Icon>
        <Alert.Title>{t("Restore complete")}</Alert.Title>
        <Alert.Description>
          {t(
            "Restart the JustAI backend so background workers load the restored data, then sign in with an account from the backup."
          )}
        </Alert.Description>
        <Alert.Actions>
          <Button onClick={onFinish} size="sm" type="button">
            {t("Go to sign-in")}
          </Button>
        </Alert.Actions>
      </Alert>
    )
  }
  if (status.status === "failed") {
    return (
      <Alert tone="destructive" variant="plain">
        <Alert.Title>{t("Restore failed")}</Alert.Title>
        <Alert.Description>{status.error}</Alert.Description>
        <Alert.Actions>
          <Button onClick={onDismiss} size="sm" type="button" variant="outline">
            {t("Close")}
          </Button>
        </Alert.Actions>
      </Alert>
    )
  }
  return (
    <div className="flex flex-col gap-3" role="status">
      <Progress
        aria-label={t("Restore progress")}
        value={backupRestorePercent(progress)}
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <Spinner className="size-4" />
          {t(phaseLabel[progress.phase ?? "database"] ?? "Restoring")}
        </span>
      </Progress>
      <p className="text-xs text-muted-foreground">
        {progress.phase === "files"
          ? t("{done} of {total} files ({size})", {
              done: number(progress.filesDone ?? 0),
              total: number(progress.filesTotal ?? 0),
              size: bytes(progress.bytesTotal ?? 0),
            })
          : t("{done} of {total} rows", {
              done: number(progress.rowsDone ?? 0),
              total: number(progress.rowsTotal ?? 0),
            })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(
          "Keep this page open. Your session ends when the database is replaced; progress stays visible here."
        )}
      </p>
    </div>
  )
}
