# Legacy incident private-data migration (issue #103)

This runbook covers the one-off cleanup for private incident fields written to
`city-incidents` before the H2 sidecar/redaction fix. The migration moves those
values to the private `city-incident-internal` dataset and leaves a redacted
public record behind.

The command is a Rust binary in the existing City service crate. It uses the
same published Tier-2 SDK family as the service and touches only these City
datasets:

- `city-incidents` — list/read and full-record CAS patch;
- `city-incident-internal` — read, create, and CAS patch with `publish:false`.

It never calls Tier 1, a database, localhost, SynapseCitySOS, or a City API. Tests
use an in-process wiremock server and fake credentials; they make no network
calls to a real Tier-2 deployment.

## Safety contract

- **Dry-run is the default.** No remote or backup writes occur without
  `--apply`.
- **`--apply` requires `--backup-dir`.** The directory must be empty (or absent),
  outside this repository, and is made owner-only on Unix. A non-empty directory
  is rejected rather than overwritten.
- **Backup precedes every mutation.** All affected original public records and
  all existing sidecars are serialized, checksummed, written with `create_new`,
  synced, and recorded in `manifest.json` before the first Tier-2 write.
- **Sidecar first.** Private values are safely stored before they are removed
  from the public record. A failure between those writes is safe to rerun.
- **CAS only for existing records.** Existing sidecars and all public patches
  send the version read from Tier-2 as `ifVersion`. New sidecars use the
  canonical id `internal-{incident-id}` and `publish:false`.
- **No lost sidecar updates.** Existing unrelated sidecar fields are retained.
  A legacy private value is added only when that field is absent; a differing
  value already in the sidecar stops planning before any writes. Internal
  comments are unioned by id (or canonical JSON when no id exists), with
  differing same-id comments treated as a conflict.
- **Bounded conflict handling.** Each sidecar/public write gets the initial
  attempt plus at most three conflict retries. A 409 causes a fresh read and a
  new CAS attempt. If a concurrent public writer introduced new private values,
  those are moved to the sidecar before the public retry.
- **Public data is preserved.** The public patch starts from the full current
  record, removes private keys, and changes only `comments`. It does not change
  publication state, status, public visibility, or unrelated public fields.
- **Logs are value-free.** Reports contain counts, record ids, stages, HTTP
  status/code, and a sanitized request id. SDK messages/bodies, record values,
  URLs with credentials, and credentials are never printed.

## Preconditions

1. Schedule a write freeze for incident creates/updates and sidecar writes.
   Offset paging is not a snapshot; the freeze prevents records being skipped or
   changed between planning and apply. CAS still protects each write.
2. Use a dedicated, least-privilege Tier-2 service credential that can list/read
   `city-incidents`, read/write `city-incident-internal`, and patch
   `city-incidents`. Do not use a personal session token.
3. Put the credential in the process environment through the operator's secret
   manager. The supported variables are `SYNAPSEDX_API_KEY` or
   `SYNAPSEDX_TOKEN`; never put either on the command line.
4. Keep `SYNAPSEDX_BASE_URL` at the default `https://synapsedx.sbs` or another
   public HTTPS Tier-2 endpoint. The command rejects HTTP, embedded credentials,
   localhost, private/link-local IPs, and internal hostnames.
5. Choose sensitive backup storage outside the repository. The backup contains
   private reporter/contact/operational data and must be encrypted at rest with
   restricted access and an approved retention period.
6. Build/test from this branch before using the credential. The normal release
   image does not ship this maintenance binary; run it from a trusted checkout
   or a purpose-built operator environment.

## Run

From the repository root:

```bash
# Build and run the mock-only suite first.
npm run test:incident-private-data-migration

# Read-only plan. This is also the default when --apply is omitted.
npm run migrate:incident-private-data

# Explicit apply. Supply the credential through the environment, not argv.
npm run migrate:incident-private-data -- \
  --apply --backup-dir /secure/synapsecity/incident-private-20261127
```

The equivalent direct binary command is:

```bash
cargo run --manifest-path apps/city-service/Cargo.toml \
  --bin migrate-incident-private-data -- \
  --apply --backup-dir /secure/synapsecity/incident-private-20261127
```

`--backup-dir` may be supplied during dry-run to validate the intended path,
but dry-run does not create or modify it. For apply, use a new directory for
each run so previous evidence is never overwritten.

## What is migrated

The private-key list is contract-tested against
`plugins/workflows/generate-workspace-actions.mjs`, which generates the current
workflow redaction artifacts:

```text
reported_by, reporter_type, contact_info, reporter_name, reporter_phone,
reporter_email, reporter_id_card, internal_notes, internal_attachments,
assigned_to, assigned_at, resolution_notes, merged_reporter_ids,
maintenance_record_id, cost_status, cost_approved_at, cost_approval_id,
cost_approved_by, cost_approval_roles, internal_comments, upvoters, merge_notes
```

The original `reporter_type` is preserved in the private sidecar. Public records
are normalized to `reporter_type: "citizen"` so a Tier-2 merge/projection cannot
retain sensitive role values such as `technician`, `system`, or `admin`.

Both a legacy top-level `internal_comments` array and entries in `comments`
with `is_internal:true` are moved. Public comments retain only `id`, `comment`,
`posted_at`, `created_at`, and `is_internal:false`; `user_name` is retained only
with `public_author:true`. That public-author marker is retained as well so a
second migration run cannot mistake an approved display name for a legacy
private identity. Internal comments, `user_id`, and non-public author identity
are removed from the public record.

For each affected incident, the command looks for `internal-{id}` first and
then the legacy sidecar id `{id}`. If neither exists, it creates the canonical
sidecar. The canonical sidecar is preferred if both exist, matching the current
workflow behavior; operators should separately reconcile duplicate sidecars.

## Paging, idempotency, and partial failures

The command requests `limit=500` and advances by offset until Tier-2 reports the
complete total or an empty page. It scans every incident, including unpublished
and non-public-visible incidents.

A completed record has no private keys/internal comments and normalized public
comments, so a rerun counts it as already clean and performs no writes. If a
sidecar write succeeds but the public patch fails, rerunning merges nothing new
into the sidecar and retries only the remaining public cleanup.

Planning is fail-closed for the whole batch: malformed records, unavailable
versions, sidecar read failures, or differing private values already in a
sidecar produce errors and prevent all apply writes. After backups are complete,
per-record apply failures are reported and other records continue. The final
status is `partial` when at least one record completed, otherwise `error`.

There is no multi-record transaction. Do not delete the backup after a partial
run. Investigate sanitized error codes, resolve the cause, and rerun with a new
backup directory.

## Report and exit codes

The command prints one JSON report. Important counters include:

- `scanned`, `affected`, `already_clean`;
- `planned_sidecar_creates`, `planned_sidecar_updates`,
  `planned_public_patches`;
- `backed_up_public_records`, `backed_up_sidecars`;
- `applied_records`, `sidecars_created`, `sidecars_updated`,
  `public_records_patched`, `conflicts`;
- `errors[]` with `record_id`, `stage`, `code`, and optional HTTP/request ids.

Exit code `0` means success (including a successful dry-run), `1` means a
migration/report error or partial apply, and `2` means invalid arguments,
endpoint, credential, or client configuration. Do not paste record bodies into
tickets when escalating; the sanitized report is sufficient for initial triage.

## Backup layout and rollback

A completed backup directory contains:

```text
manifest.json
city-incidents-<sha256>.json
city-incident-internal-<sha256>.json   # only for existing sidecars
```

Each record file is the original Tier-2 `RecordItem` envelope (`id`, `data`,
`version`, publication/timestamps). `manifest.json` maps incident ids to files,
record ids/versions, and SHA-256 digests. Filenames use hashes rather than raw
record ids. Unix directory/file modes are `0700`/`0600`.

For rollback, stop incident writers, retain the backup, and have an authorized
operator restore the exact saved envelopes through the Tier-2 records API using
the **current** remote version for CAS. Never blindly reuse the saved version if
the record has changed since backup. Restoring a public envelope reintroduces
private data into `city-incidents`; do it only as an explicit rollback, keep the
window short, and rerun the migration after the underlying issue is resolved.
This command intentionally does not provide an automatic rollback mode.

## Verification checklist

1. Confirm the dry-run `scanned` count matches the operator's independent Tier-2
   count and `errors` is empty.
2. Confirm the selected backup directory is outside the repository and access is
   restricted before apply.
3. Apply during the write freeze and retain the JSON report with the change
   record (it contains no record values or credentials).
4. Require `status:"ok"`, no `errors`, and `applied_records == affected`.
5. Rerun dry-run. Require `affected:0`, `already_clean == scanned`, and no
   writes/backup directory creation.
6. Through authorized Tier-2 reads, spot-check representative public records for
   absent private keys/internal comments and representative sidecars for the
   moved values plus preserved unrelated fields. Do not print the values.
7. End the write freeze only after verification. Retain/delete the sensitive
   backup according to the approved retention policy.

## Tests

`npm run test:incident-private-data-migration` runs mock-based tests for:

- default dry-run and 500-record pagination across multiple pages;
- legacy-sidecar merge and public redaction with CAS bodies;
- idempotent rerun;
- sidecar/public 409 refresh-and-retry and bounded retry exhaustion;
- complete pre-mutation backups, hashes, and Unix permissions;
- fail-closed sidecar value conflicts;
- workflow field-list parity, endpoint guards, and redaction idempotency.

Formatting/lint checks used for this change:

```bash
rustfmt --edition 2021 --check apps/city-service/src/bin/migrate-incident-private-data.rs
cargo clippy --manifest-path apps/city-service/Cargo.toml \
  --bin migrate-incident-private-data -- -D warnings
git diff --check
```
