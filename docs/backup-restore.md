# Backup and restore

Platform administrators can save a whole JustAI instance as one ZIP archive
and restore it on the same or another instance. Both live in
**Administration → Backup**.

## What a backup contains

| Part | Contents |
| --- | --- |
| `db/<table>.ndjson` | Every application table, one JSON row per line, read from one consistent database snapshot. |
| `files/local/…`, `files/s3/…` | Stored recordings and uploaded videos, grouped by the storage driver that holds them. Optional. |
| `manifest.json` | Format version, applied migrations, row and file counts, and a fingerprint of the encryption key. Written last, so an interrupted download has none and is rejected. |

Left out on purpose: sign-in sessions, one-time stream and OAuth state tokens,
rate-limit buckets, and worker heartbeats. They only make sense on the running
instance.

Switch off **Include stored files** for a small database-only backup when the
local storage directory or the S3 bucket is backed up another way.

### Encryption key

Provider keys, MCP secrets, and the keys of encrypted recordings stay
encrypted in the backup. They can only be read by an instance that uses the
same `JUSTAI_ENCRYPTION_KEY`. Keep the key with your backups, separately from
them. When the key differs, the restore still works and warns you first, but
those secrets cannot be decrypted until the key matches.

## Restoring

A restore **replaces all data** on the instance. Everyone is signed out,
including the administrator who starts it.

1. Stop live transcriptions and agent runs.
2. Open **Administration → Backup** and upload the archive. It is sent in
   16 MB chunks, the same size as video upload parts, so any archive size works
   behind a proxy that already accepts video uploads (for ingress-nginx,
   `nginx.ingress.kubernetes.io/proxy-body-size` of at least `20m`).
   Each chunk is retried on network errors and timeouts. If the upload still
   stops, or you pause it, close the tab, or reload, everything received so far
   is kept: choose the same file again and the upload continues from the last
   complete chunk.
3. JustAI checks every table and file in the archive and shows what it
   contains, plus any warnings. Nothing has changed yet; you can discard it.
4. Type `RESTORE` and start. The page follows progress with a one-time token,
   even after your session has been replaced.
5. Restart the backend so background workers load the restored data, then sign
   in with an account from the backup.

The database is replaced in one transaction. If anything fails there, nothing
changes. Stored files are copied after the database is committed. Files with
the same key are overwritten; other files in the storage are left alone.

### Versions

- A backup from the **same** JustAI version restores as is.
- A backup from an **older** version restores into the current schema.
  Columns added since then get their defaults. Data conversions that ran
  during those upgrades are not repeated, and the check warns you about that.
- A backup from a **newer** version is rejected. Upgrade this instance first.

### Staging space

Uploaded archives wait in `JUSTAI_BACKUP_STAGING_PATH` (default: a directory
in the OS temp directory) until they are restored or discarded. Point it at a
volume with room for the largest backup, for example
`/app/data/backup-staging`. Staged uploads, including paused ones, are removed
after 24 hours without activity or when a new upload starts.

With several backend replicas, the upload and the restore must reach the same
replica. The Helm chart's ingress session affinity does this.
