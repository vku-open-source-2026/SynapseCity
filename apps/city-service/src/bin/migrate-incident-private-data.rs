// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! One-off cleanup for legacy private incident data (issue #103).
//!
//! The command is dry-run by default. `--apply` requires an explicit local
//! backup directory and performs sidecar-first writes followed by a CAS public
//! patch. It intentionally reports only counts, record ids, and sanitized error
//! codes: record bodies and credentials must never reach operator logs.

use chrono::{SecondsFormat, Utc};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use synapsedx::{Client, Credentials, Error, RecordItem, RecordListQuery, RequestOptions};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const INCIDENTS_DATASET: &str = "city-incidents";
const SIDECAR_DATASET: &str = "city-incident-internal";
const PAGE_SIZE: i64 = 500;
const MAX_CONFLICT_RETRIES: usize = 3;
const DEFAULT_BASE_URL: &str = "https://synapsedx.sbs";
const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// Must stay identical to `INCIDENT_INTERNAL_FIELDS` in
/// `plugins/workflows/generate-workspace-actions.mjs` and the INTERNAL_FIELDS
/// array embedded in the dedicated incident workflow artifacts.
const INTERNAL_FIELDS: [&str; 22] = [
    "reported_by",
    "reporter_type",
    "contact_info",
    "reporter_name",
    "reporter_phone",
    "reporter_email",
    "reporter_id_card",
    "internal_notes",
    "internal_attachments",
    "assigned_to",
    "assigned_at",
    "resolution_notes",
    "merged_reporter_ids",
    "maintenance_record_id",
    "cost_status",
    "cost_approved_at",
    "cost_approval_id",
    "cost_approved_by",
    "cost_approval_roles",
    "internal_comments",
    "upvoters",
    "merge_notes",
];

const USAGE: &str = "SynapseCity legacy incident private-data migration (issue #103)\n\n\
Usage:\n  synapsecity-incident-private-migration [--apply --backup-dir <directory>]\n\n\
Options:\n  --apply             Mutate Tier-2 records; omitted means dry-run.\n  --backup-dir <dir>  Empty/local backup destination; required with --apply.\n  -h, --help          Show this help.\n\n\
Environment:\n  SYNAPSEDX_BASE_URL  Public HTTPS Tier-2 endpoint (default https://synapsedx.sbs).\n  SYNAPSEDX_API_KEY   Service API key (or use SYNAPSEDX_TOKEN).\n  SYNAPSEDX_TOKEN     Service bearer token alternative.\n\n\
Credentials and record values are never printed. See docs/INCIDENT_PRIVATE_DATA_MIGRATION.md.\n";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    DryRun,
    Apply,
}

#[derive(Clone, Debug)]
struct Options {
    mode: Mode,
    backup_dir: Option<PathBuf>,
}

#[derive(Debug)]
struct Failure {
    code: String,
    status: Option<u16>,
    request_id: Option<String>,
    field: Option<String>,
}

impl Failure {
    fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            status: None,
            request_id: None,
            field: None,
        }
    }

    fn field(code: impl Into<String>, field: impl Into<String>) -> Self {
        Self {
            field: Some(field.into()),
            ..Self::new(code)
        }
    }

    /// Deliberately discard SDK messages, response bodies, paths, and transport
    /// details. Any of those can contain operator data or credentials. Remote
    /// codes are mapped to a fixed status-based vocabulary for the same reason.
    fn from_sdk(error: Error) -> Self {
        let (code, status, request_id) = match &error {
            Error::Api {
                status, request_id, ..
            } => (
                api_error_code(*status).to_string(),
                Some(*status),
                request_id
                    .as_str()
                    .parse::<uuid::Uuid>()
                    .ok()
                    .map(|value| value.to_string()),
            ),
            Error::Network { .. } => ("network_error".into(), None, None),
            Error::Config(_) => ("configuration_error".into(), None, None),
            Error::Json(_) => ("invalid_response".into(), None, None),
            Error::Header(_) => ("invalid_header".into(), None, None),
        };
        Self {
            code,
            status,
            request_id,
            field: None,
        }
    }

    fn is_conflict(&self) -> bool {
        self.status == Some(409)
    }
}

#[derive(Clone, Debug, Serialize)]
struct ReportError {
    #[serde(skip_serializing_if = "Option::is_none")]
    record_id: Option<String>,
    stage: String,
    code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

impl ReportError {
    fn new(record_id: Option<&str>, stage: &str, failure: Failure) -> Self {
        Self {
            record_id: record_id.map(str::to_string),
            stage: stage.to_string(),
            code: failure.code,
            field: failure.field,
            http_status: failure.status,
            request_id: failure.request_id,
        }
    }
}

#[derive(Debug, Serialize)]
struct Report {
    mode: Mode,
    status: String,
    scanned: usize,
    affected: usize,
    already_clean: usize,
    planned_sidecar_creates: usize,
    planned_sidecar_updates: usize,
    planned_public_patches: usize,
    backed_up_public_records: usize,
    backed_up_sidecars: usize,
    applied_records: usize,
    sidecars_created: usize,
    sidecars_updated: usize,
    public_records_patched: usize,
    conflicts: usize,
    errors: Vec<ReportError>,
}

impl Report {
    fn new(mode: Mode) -> Self {
        Self {
            mode,
            status: "ok".into(),
            scanned: 0,
            affected: 0,
            already_clean: 0,
            planned_sidecar_creates: 0,
            planned_sidecar_updates: 0,
            planned_public_patches: 0,
            backed_up_public_records: 0,
            backed_up_sidecars: 0,
            applied_records: 0,
            sidecars_created: 0,
            sidecars_updated: 0,
            public_records_patched: 0,
            conflicts: 0,
            errors: Vec::new(),
        }
    }

    fn has_errors(&self) -> bool {
        !self.errors.is_empty()
    }
}

#[derive(Clone)]
struct SidecarWrite {
    id: String,
    data: Map<String, Value>,
    exists: bool,
}

#[derive(Clone)]
struct Plan {
    incident: RecordItem,
    existing_sidecar: Option<RecordItem>,
    sidecar_write: Option<SidecarWrite>,
}

#[derive(Default)]
struct ApplyCounts {
    applied_records: usize,
    sidecars_created: usize,
    sidecars_updated: usize,
    public_records_patched: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct BackupFile {
    record_id: String,
    version: i64,
    file: String,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct BackupEntry {
    incident_id: String,
    public: BackupFile,
    #[serde(skip_serializing_if = "Option::is_none")]
    sidecar: Option<BackupFile>,
}

#[derive(Debug, Deserialize, Serialize)]
struct BackupManifest {
    format_version: u8,
    created_at: String,
    public_dataset: String,
    sidecar_dataset: String,
    records: Vec<BackupEntry>,
}

fn api_error_code(status: u16) -> &'static str {
    match status {
        400 => "bad_request",
        401 => "unauthorized",
        403 => "forbidden",
        404 => "not_found",
        409 => "version_conflict",
        429 => "rate_limited",
        _ => "api_error",
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn object_data(item: &RecordItem) -> Result<Map<String, Value>, Failure> {
    item.data
        .as_object()
        .cloned()
        .ok_or_else(|| Failure::new("invalid_record_data"))
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn public_comment(entry: &Value) -> Option<Value> {
    let entry = entry.as_object()?;
    if matches!(entry.get("is_internal"), Some(Value::Bool(true))) {
        return None;
    }
    let mut clean = Map::new();
    for key in ["id", "comment", "posted_at", "created_at"] {
        if let Some(value) = entry.get(key) {
            clean.insert(key.to_string(), value.clone());
        }
    }
    clean.insert("is_internal".into(), Value::Bool(false));
    if matches!(entry.get("public_author"), Some(Value::Bool(true)))
        && entry.get("user_name").is_some_and(js_truthy)
    {
        if let Some(value) = entry.get("user_name") {
            clean.insert("user_name".into(), value.clone());
        }
        // Retain the public-author marker so a rerun does not mistake the
        // already-approved display name for a legacy private identity.
        clean.insert("public_author".into(), Value::Bool(true));
    }
    Some(Value::Object(clean))
}

fn redacted_comments(comments: &[Value]) -> Vec<Value> {
    comments
        .iter()
        .filter_map(public_comment)
        .collect::<Vec<_>>()
}

fn is_affected(data: &Map<String, Value>) -> bool {
    if INTERNAL_FIELDS
        .iter()
        .any(|field| data.contains_key(*field))
    {
        return true;
    }
    match data.get("comments").and_then(Value::as_array) {
        Some(comments) => {
            comments
                .iter()
                .any(|entry| matches!(entry.get("is_internal"), Some(Value::Bool(true))))
                || redacted_comments(comments) != comments.to_vec()
        }
        None => false,
    }
}

/// Full-record public patch: remove workflow-private keys and normalize every
/// public comment, while retaining all unrelated/public fields verbatim.
fn public_record(data: &Map<String, Value>) -> Map<String, Value> {
    let mut next = data.clone();
    for field in INTERNAL_FIELDS {
        next.remove(field);
    }
    let comments = data
        .get("comments")
        .and_then(Value::as_array)
        .map(|comments| redacted_comments(comments))
        .unwrap_or_default();
    next.insert("comments".into(), Value::Array(comments));
    next
}

/// Extract all workflow-private values, including a legacy top-level
/// `internal_comments` array as well as `comments[].is_internal === true`.
fn private_record(data: &Map<String, Value>) -> Result<Map<String, Value>, Failure> {
    let mut private = Map::new();
    for field in INTERNAL_FIELDS {
        if field == "internal_comments" {
            continue;
        }
        if let Some(value) = data.get(field) {
            private.insert((*field).to_string(), value.clone());
        }
    }

    let mut comments = Vec::new();
    if let Some(value) = data.get("internal_comments") {
        match value {
            Value::Null => {}
            Value::Array(entries) => comments.extend(entries.iter().cloned()),
            _ => return Err(Failure::new("invalid_internal_comments")),
        }
    }
    if let Some(entries) = data.get("comments").and_then(Value::as_array) {
        comments.extend(
            entries
                .iter()
                .filter(|entry| matches!(entry.get("is_internal"), Some(Value::Bool(true))))
                .cloned(),
        );
    }
    if !comments.is_empty() {
        private.insert("internal_comments".into(), Value::Array(comments));
    }
    Ok(private)
}

fn comment_identity(entry: &Value) -> String {
    if let Some(id) = entry
        .as_object()
        .and_then(|entry| entry.get("id"))
        .filter(|id| js_truthy(id))
    {
        let identity = match id {
            Value::String(value) => value.clone(),
            other => other.to_string(),
        };
        return format!("id:{identity}");
    }
    format!(
        "value:{}",
        serde_json::to_string(entry).unwrap_or_else(|_| "null".into())
    )
}

fn merge_comments(existing: &[Value], incoming: &[Value]) -> Result<Vec<Value>, Failure> {
    let mut merged = Vec::new();
    let mut seen = BTreeMap::<String, Value>::new();
    for entry in existing.iter().chain(incoming) {
        let key = comment_identity(entry);
        if let Some(previous) = seen.get(&key) {
            if previous != entry {
                return Err(Failure::new("sidecar_comment_conflict"));
            }
            continue;
        }
        seen.insert(key, entry.clone());
        merged.push(entry.clone());
    }
    Ok(merged)
}

async fn list_all_incidents(client: &Client) -> Result<Vec<RecordItem>, Failure> {
    let mut records = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut offset = 0_i64;
    let opts = RequestOptions::new().retries(0);
    loop {
        let page = client
            .records()
            .list(
                INCIDENTS_DATASET,
                RecordListQuery::new().limit(PAGE_SIZE).offset(offset),
                &opts,
            )
            .await
            .map_err(Failure::from_sdk)?;
        let count = page.items.len() as i64;
        if count == 0 {
            break;
        }
        for item in page.items {
            if item.id.is_empty() || !seen_ids.insert(item.id.clone()) {
                return Err(Failure::new("invalid_or_duplicate_record_id"));
            }
            records.push(item);
        }
        offset += count;
        if page.total >= 0 && offset >= page.total {
            break;
        }
        // A short unknown-total page is treated as final; a full page keeps
        // paging until Tier-2 returns an empty page.
        if count < PAGE_SIZE && page.total < 0 {
            break;
        }
    }
    Ok(records)
}

fn records_path(dataset: &str) -> String {
    format!("/v1/capabilities/datasets/{dataset}/records")
}

fn record_path(dataset: &str, id: &str) -> String {
    format!(
        "{}/{}",
        records_path(dataset),
        utf8_percent_encode(id, PATH_SEGMENT)
    )
}

async fn get_public(client: &Client, id: &str) -> Result<RecordItem, Failure> {
    client
        .records()
        .get(INCIDENTS_DATASET, id, &RequestOptions::new().retries(0))
        .await
        .map_err(Failure::from_sdk)
}

async fn find_sidecar(client: &Client, incident_id: &str) -> Result<Option<RecordItem>, Failure> {
    let canonical = format!("internal-{incident_id}");
    for id in [canonical, incident_id.to_string()] {
        match client
            .records()
            .get(SIDECAR_DATASET, &id, &RequestOptions::new().retries(0))
            .await
        {
            Ok(item) => {
                object_data(&item)?;
                if item.version <= 0 {
                    return Err(Failure::new("sidecar_version_unavailable"));
                }
                return Ok(Some(item));
            }
            Err(error) if error.is_not_found() => {}
            Err(error) => return Err(Failure::from_sdk(error)),
        }
    }
    Ok(None)
}

fn merge_sidecar(
    incident_id: &str,
    existing: Option<&RecordItem>,
    private: &Map<String, Value>,
) -> Result<Option<SidecarWrite>, Failure> {
    if private.is_empty() {
        return Ok(None);
    }
    let exists = existing.is_some();
    let sidecar_id = existing
        .map(|item| item.id.clone())
        .unwrap_or_else(|| format!("internal-{incident_id}"));
    let mut data = existing.map(object_data).transpose()?.unwrap_or_default();
    let mut changed = !exists;

    for (field, value) in private {
        if field == "internal_comments" {
            continue;
        }
        match data.get(field) {
            None => {
                data.insert(field.clone(), value.clone());
                changed = true;
            }
            Some(current) if current == value => {}
            Some(_) => return Err(Failure::field("sidecar_field_conflict", field)),
        }
    }

    if let Some(incoming) = private.get("internal_comments").and_then(Value::as_array) {
        if !incoming.is_empty() {
            match data.get("internal_comments") {
                None => {
                    data.insert(
                        "internal_comments".into(),
                        Value::Array(merge_comments(&[], incoming)?),
                    );
                    changed = true;
                }
                Some(Value::Array(current)) => {
                    let merged = merge_comments(current, incoming)?;
                    if &merged != current {
                        data.insert("internal_comments".into(), Value::Array(merged));
                        changed = true;
                    }
                }
                Some(_) => return Err(Failure::new("invalid_sidecar_comments")),
            }
        }
    }

    if data.get("id") != Some(&Value::String(sidecar_id.clone())) {
        data.insert("id".into(), Value::String(sidecar_id.clone()));
        changed = true;
    }
    if data.get("incident_id") != Some(&Value::String(incident_id.to_string())) {
        data.insert("incident_id".into(), Value::String(incident_id.to_string()));
        changed = true;
    }
    if changed {
        data.insert("updated_at".into(), Value::String(now_iso()));
    }

    if !changed {
        return Ok(None);
    }
    Ok(Some(SidecarWrite {
        id: sidecar_id,
        data,
        exists,
    }))
}

async fn prepare_plan(client: &Client, incident: RecordItem) -> Result<Option<Plan>, Failure> {
    let data = object_data(&incident)?;
    if !is_affected(&data) {
        return Ok(None);
    }
    if incident.version <= 0 {
        return Err(Failure::new("public_version_unavailable"));
    }
    let private = private_record(&data)?;
    let existing_sidecar = find_sidecar(client, &incident.id).await?;
    let sidecar_write = merge_sidecar(&incident.id, existing_sidecar.as_ref(), &private)?;
    Ok(Some(Plan {
        incident,
        existing_sidecar,
        sidecar_write,
    }))
}

fn backup_filename(dataset: &str, record_id: &str) -> String {
    let digest = Sha256::digest(format!("{dataset}\0{record_id}").as_bytes());
    format!("{dataset}-{}.json", hex_lower(&digest))
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn backup_file(dataset: &str, item: &RecordItem) -> Result<BackupFile, Failure> {
    let file = backup_filename(dataset, &item.id);
    let bytes =
        serde_json::to_vec_pretty(item).map_err(|_| Failure::new("backup_serialization_failed"))?;
    Ok(BackupFile {
        record_id: item.id.clone(),
        version: item.version,
        sha256: hex_lower(&Sha256::digest(&bytes)),
        file,
    })
}

fn write_new_private_file(path: &Path, bytes: &[u8]) -> Result<(), Failure> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .map_err(|_| Failure::new("backup_write_failed"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| Failure::new("backup_write_failed"))
}

fn prepare_backup_dir(path: &Path) -> Result<PathBuf, Failure> {
    if path.exists() {
        let metadata =
            fs::metadata(path).map_err(|_| Failure::new("backup_directory_unavailable"))?;
        if !metadata.is_dir() {
            return Err(Failure::new("backup_directory_unavailable"));
        }
        let mut entries =
            fs::read_dir(path).map_err(|_| Failure::new("backup_directory_unavailable"))?;
        if entries.next().is_some() {
            return Err(Failure::new("backup_directory_not_empty"));
        }
    } else {
        fs::create_dir_all(path).map_err(|_| Failure::new("backup_create_failed"))?;
    }

    let directory =
        fs::canonicalize(path).map_err(|_| Failure::new("backup_directory_unavailable"))?;
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .map_err(|_| Failure::new("backup_repository_check_failed"))?;
    if directory.starts_with(repo) {
        return Err(Failure::new("backup_directory_inside_repository"));
    }
    #[cfg(unix)]
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|_| Failure::new("backup_permissions_failed"))?;
    Ok(directory)
}

fn write_backups(plans: &[Plan], directory: &Path) -> Result<(usize, usize), Failure> {
    let directory = prepare_backup_dir(directory)?;
    let mut entries = Vec::with_capacity(plans.len());
    let mut sidecar_count = 0;

    // Every original is written and synced before the first remote mutation.
    for plan in plans {
        let public = backup_file(INCIDENTS_DATASET, &plan.incident)?;
        let public_bytes = serde_json::to_vec_pretty(&plan.incident)
            .map_err(|_| Failure::new("backup_serialization_failed"))?;
        write_new_private_file(&directory.join(&public.file), &public_bytes)?;

        let sidecar = match &plan.existing_sidecar {
            Some(item) => {
                sidecar_count += 1;
                let backup = backup_file(SIDECAR_DATASET, item)?;
                let bytes = serde_json::to_vec_pretty(item)
                    .map_err(|_| Failure::new("backup_serialization_failed"))?;
                write_new_private_file(&directory.join(&backup.file), &bytes)?;
                Some(backup)
            }
            None => None,
        };
        entries.push(BackupEntry {
            incident_id: plan.incident.id.clone(),
            public,
            sidecar,
        });
    }

    let manifest = BackupManifest {
        format_version: 1,
        created_at: now_iso(),
        public_dataset: INCIDENTS_DATASET.into(),
        sidecar_dataset: SIDECAR_DATASET.into(),
        records: entries,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|_| Failure::new("backup_serialization_failed"))?;
    write_new_private_file(&directory.join("manifest.json"), &manifest_bytes)?;
    File::open(&directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| Failure::new("backup_sync_failed"))?;
    Ok((plans.len(), sidecar_count))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SidecarOutcome {
    Unchanged,
    Created,
    Updated,
}

async fn upsert_sidecar(
    client: &Client,
    incident: &RecordItem,
    conflicts: &mut usize,
) -> Result<SidecarOutcome, Failure> {
    let data = object_data(incident)?;
    let private = private_record(&data)?;
    if private.is_empty() {
        return Ok(SidecarOutcome::Unchanged);
    }
    let opts = RequestOptions::new().retries(0);

    for attempt in 0..=MAX_CONFLICT_RETRIES {
        let existing = find_sidecar(client, &incident.id).await?;
        let Some(write) = merge_sidecar(&incident.id, existing.as_ref(), &private)? else {
            return Ok(SidecarOutcome::Unchanged);
        };
        let result = if write.exists {
            let version = existing
                .as_ref()
                .ok_or_else(|| Failure::new("sidecar_version_unavailable"))?
                .version;
            client
                .patch(
                    record_path(SIDECAR_DATASET, &write.id),
                    json!({
                        "data": write.data,
                        "ifVersion": version,
                        "publish": false,
                    }),
                    &opts,
                )
                .await
        } else {
            client
                .post(
                    records_path(SIDECAR_DATASET),
                    json!({
                        "id": write.id,
                        "data": write.data,
                        "publish": false,
                    }),
                    &opts,
                )
                .await
        };

        match result {
            Ok(_) => {
                return Ok(if write.exists {
                    SidecarOutcome::Updated
                } else {
                    SidecarOutcome::Created
                });
            }
            Err(error) => {
                let failure = Failure::from_sdk(error);
                if failure.is_conflict() && attempt < MAX_CONFLICT_RETRIES {
                    *conflicts += 1;
                    continue;
                }
                return Err(failure);
            }
        }
    }
    Err(Failure::new("conflict_retries_exhausted"))
}

async fn patch_public(
    client: &Client,
    snapshot: &RecordItem,
    conflicts: &mut usize,
    counts: &mut ApplyCounts,
) -> Result<bool, Failure> {
    let mut current = snapshot.clone();
    let opts = RequestOptions::new().retries(0);

    for attempt in 0..=MAX_CONFLICT_RETRIES {
        let data = object_data(&current)?;
        if !is_affected(&data) {
            return Ok(false);
        }
        if current.version <= 0 {
            return Err(Failure::new("public_version_unavailable"));
        }
        let next = public_record(&data);
        let result = client
            .patch(
                record_path(INCIDENTS_DATASET, &current.id),
                json!({
                    "data": next,
                    "ifVersion": current.version,
                }),
                &opts,
            )
            .await;
        match result {
            Ok(_) => return Ok(true),
            Err(error) => {
                let failure = Failure::from_sdk(error);
                if failure.is_conflict() && attempt < MAX_CONFLICT_RETRIES {
                    *conflicts += 1;
                    current = get_public(client, &current.id).await?;
                    // A concurrent writer may have introduced new private
                    // values. Move those to the sidecar before retrying.
                    match upsert_sidecar(client, &current, conflicts).await? {
                        SidecarOutcome::Created => counts.sidecars_created += 1,
                        SidecarOutcome::Updated => counts.sidecars_updated += 1,
                        SidecarOutcome::Unchanged => {}
                    }
                    continue;
                }
                return Err(failure);
            }
        }
    }
    Err(Failure::new("conflict_retries_exhausted"))
}

async fn apply_plan(
    client: &Client,
    plan: Plan,
    conflicts: &mut usize,
) -> (ApplyCounts, Option<(&'static str, Failure)>) {
    let mut counts = ApplyCounts::default();
    match upsert_sidecar(client, &plan.incident, conflicts).await {
        Ok(SidecarOutcome::Created) => counts.sidecars_created = 1,
        Ok(SidecarOutcome::Updated) => counts.sidecars_updated = 1,
        Ok(SidecarOutcome::Unchanged) => {}
        Err(failure) => return (counts, Some(("sidecar_write", failure))),
    }
    match patch_public(client, &plan.incident, conflicts, &mut counts).await {
        Ok(patched) => {
            counts.public_records_patched = usize::from(patched);
            counts.applied_records = 1;
            (counts, None)
        }
        Err(failure) => (counts, Some(("public_patch", failure))),
    }
}

async fn run_migration(client: &Client, options: Options) -> Report {
    let mut report = Report::new(options.mode);
    let incidents = match list_all_incidents(client).await {
        Ok(incidents) => incidents,
        Err(failure) => {
            report.status = "error".into();
            report.errors.push(ReportError::new(None, "list", failure));
            return report;
        }
    };
    report.scanned = incidents.len();

    let mut plans = Vec::new();
    for incident in incidents {
        let record_id = incident.id.clone();
        match prepare_plan(client, incident).await {
            Ok(Some(plan)) => {
                report.affected += 1;
                report.planned_public_patches += 1;
                match &plan.sidecar_write {
                    Some(write) if write.exists => report.planned_sidecar_updates += 1,
                    Some(_) => report.planned_sidecar_creates += 1,
                    None => {}
                }
                plans.push(plan);
            }
            Ok(None) => report.already_clean += 1,
            Err(failure) => {
                report
                    .errors
                    .push(ReportError::new(Some(&record_id), "plan", failure));
            }
        }
    }

    if options.mode == Mode::DryRun {
        if report.has_errors() {
            report.status = "error".into();
        }
        return report;
    }

    // Fail closed: no remote writes if even one record could not be planned.
    if report.has_errors() {
        report.status = "error".into();
        return report;
    }
    let Some(directory) = options.backup_dir.as_deref() else {
        report.status = "error".into();
        report.errors.push(ReportError::new(
            None,
            "backup",
            Failure::new("backup_directory_required"),
        ));
        return report;
    };
    match write_backups(&plans, directory) {
        Ok((public_count, sidecar_count)) => {
            report.backed_up_public_records = public_count;
            report.backed_up_sidecars = sidecar_count;
        }
        Err(failure) => {
            report.status = "error".into();
            report
                .errors
                .push(ReportError::new(None, "backup", failure));
            return report;
        }
    }

    for plan in plans {
        let record_id = plan.incident.id.clone();
        let (counts, failure) = apply_plan(client, plan, &mut report.conflicts).await;
        report.applied_records += counts.applied_records;
        report.sidecars_created += counts.sidecars_created;
        report.sidecars_updated += counts.sidecars_updated;
        report.public_records_patched += counts.public_records_patched;
        if let Some((stage, failure)) = failure {
            report
                .errors
                .push(ReportError::new(Some(&record_id), stage, failure));
        }
    }

    report.status = if report.errors.is_empty() {
        "ok"
    } else if report.applied_records > 0 {
        "partial"
    } else {
        "error"
    }
    .into();
    report
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Option<Options>, &'static str> {
    let mut apply = false;
    let mut backup_dir = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--apply" => apply = true,
            "--backup-dir" => {
                let value = args.next().ok_or("backup_dir_value_required")?;
                if value.is_empty() || value.starts_with("--") {
                    return Err("backup_dir_value_required");
                }
                backup_dir = Some(PathBuf::from(value));
            }
            "-h" | "--help" => return Ok(None),
            _ => return Err("unknown_argument"),
        }
    }
    if apply && backup_dir.is_none() {
        return Err("backup_dir_required_for_apply");
    }
    Ok(Some(Options {
        mode: if apply { Mode::Apply } else { Mode::DryRun },
        backup_dir,
    }))
}

fn is_private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_multicast()
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| is_private_ip(std::net::IpAddr::V4(mapped)))
        }
    }
}

fn is_private_hostname(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host == "host.docker.internal"
        || host == "gateway.docker.internal"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".docker")
        || host.ends_with(".svc")
        || host.ends_with(".cluster.local")
        || !host.contains('.')
}

fn public_https_base(raw: &str) -> Result<String, &'static str> {
    let url = url::Url::parse(raw).map_err(|_| "invalid_tier2_base_url")?;
    if url.scheme() != "https" {
        return Err("tier2_base_url_must_be_https");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("tier2_base_url_must_not_contain_credentials");
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("invalid_tier2_base_url");
    }
    let host = url.host_str().ok_or("invalid_tier2_base_url")?;
    let parsed_ip = host.parse::<std::net::IpAddr>().ok();
    if parsed_ip.is_some_and(is_private_ip) || (parsed_ip.is_none() && is_private_hostname(host)) {
        return Err("tier2_base_url_must_be_public");
    }
    Ok(raw.trim_end_matches('/').to_string())
}

fn valid_credential(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8192 && !value.chars().any(|ch| ch.is_control())
}

fn credentials_from_env() -> Result<Credentials, &'static str> {
    let token = env::var("SYNAPSEDX_TOKEN").unwrap_or_default();
    let api_key = env::var("SYNAPSEDX_API_KEY").unwrap_or_default();
    let token = token.trim();
    let api_key = api_key.trim();
    if token.is_empty() && api_key.is_empty() {
        return Err("service_credential_required");
    }
    if (!token.is_empty() && !valid_credential(token))
        || (!api_key.is_empty() && !valid_credential(api_key))
    {
        return Err("invalid_service_credential");
    }
    let mut credentials = Credentials::none();
    if !token.is_empty() {
        credentials = credentials.with_token(token);
    }
    if !api_key.is_empty() {
        credentials = credentials.with_api_key(api_key);
    }
    Ok(credentials)
}

#[tokio::main]
async fn main() {
    let options = match parse_args(env::args().skip(1)) {
        Ok(Some(options)) => options,
        Ok(None) => {
            print!("{USAGE}");
            return;
        }
        Err(code) => {
            eprintln!("{code}");
            print!("{USAGE}");
            std::process::exit(2);
        }
    };

    let base = match env::var("SYNAPSEDX_BASE_URL") {
        Ok(value) => value,
        Err(_) => DEFAULT_BASE_URL.into(),
    };
    let base = match public_https_base(&base) {
        Ok(base) => base,
        Err(code) => {
            eprintln!("{code}");
            std::process::exit(2);
        }
    };
    let credentials = match credentials_from_env() {
        Ok(credentials) => credentials,
        Err(code) => {
            eprintln!("{code}");
            std::process::exit(2);
        }
    };
    let client = match Client::builder(base)
        .credentials(credentials)
        .timeout(Duration::from_secs(30))
        .retries(0)
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            eprintln!("configuration_error");
            std::process::exit(2);
        }
    };

    let report = run_migration(&client, options).await;
    match serde_json::to_string_pretty(&report) {
        Ok(output) => println!("{output}"),
        Err(_) => {
            eprintln!("report_serialization_failed");
            std::process::exit(1);
        }
    }
    if report.status != "ok" {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use wiremock::matchers::any;
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    const TEST_CREDENTIAL: &str = "test-service-credential";

    #[derive(Clone, Debug)]
    struct RecordedRequest {
        method: String,
        path: String,
        query: Vec<(String, String)>,
        body: Option<Value>,
        api_key: Option<String>,
    }

    #[derive(Default)]
    struct MockState {
        incidents: BTreeMap<String, RecordItem>,
        sidecars: BTreeMap<String, RecordItem>,
        requests: Vec<RecordedRequest>,
        sidecar_conflicts: usize,
        public_conflicts: usize,
        sidecar_conflict_patch: Map<String, Value>,
        public_conflict_patch: Map<String, Value>,
        backup_dir: Option<PathBuf>,
        mutation_before_backup: bool,
    }

    struct MockTier2 {
        state: Arc<Mutex<MockState>>,
    }

    impl MockTier2 {
        fn new(incidents: Vec<RecordItem>, sidecars: Vec<RecordItem>) -> Self {
            Self {
                state: Arc::new(Mutex::new(MockState {
                    incidents: incidents
                        .into_iter()
                        .map(|item| (item.id.clone(), item))
                        .collect(),
                    sidecars: sidecars
                        .into_iter()
                        .map(|item| (item.id.clone(), item))
                        .collect(),
                    ..MockState::default()
                })),
            }
        }

        async fn mount(&self, server: &MockServer) {
            let state = Arc::clone(&self.state);
            Mock::given(any())
                .respond_with(move |request: &Request| {
                    let method = request.method.to_string();
                    let path = request.url.path().to_string();
                    let query = request
                        .url
                        .query_pairs()
                        .map(|(key, value)| (key.into_owned(), value.into_owned()))
                        .collect::<Vec<_>>();
                    let body = if request.body.is_empty() {
                        None
                    } else {
                        serde_json::from_slice(&request.body).ok()
                    };
                    let api_key = request
                        .headers
                        .get("x-api-key")
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_string);
                    let authenticated = api_key.as_deref() == Some(TEST_CREDENTIAL);
                    let mut state = state.lock().expect("mock state lock");
                    state.requests.push(RecordedRequest {
                        method: method.clone(),
                        path: path.clone(),
                        query,
                        body,
                        api_key,
                    });
                    if !authenticated {
                        return ResponseTemplate::new(401)
                            .set_body_json(json!({"error": {"code": "unauthorized"}}));
                    }
                    let public_base = records_path(INCIDENTS_DATASET);
                    let sidecar_base = records_path(SIDECAR_DATASET);
                    if method == "GET" && path == public_base {
                        let limit = state
                            .requests
                            .last()
                            .and_then(|request| {
                                request
                                    .query
                                    .iter()
                                    .find(|(key, _)| key == "limit")
                                    .and_then(|(_, value)| value.parse::<usize>().ok())
                            })
                            .unwrap_or(500);
                        let offset = state
                            .requests
                            .last()
                            .and_then(|request| {
                                request
                                    .query
                                    .iter()
                                    .find(|(key, _)| key == "offset")
                                    .and_then(|(_, value)| value.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        let total = state.incidents.len();
                        let items = state
                            .incidents
                            .values()
                            .skip(offset)
                            .take(limit)
                            .cloned()
                            .collect::<Vec<_>>();
                        return ResponseTemplate::new(200).set_body_json(json!({
                            "items": items,
                            "total": total,
                            "limit": limit,
                            "offset": offset,
                            "nextCursor": null,
                        }));
                    }
                    if method == "GET" {
                        if let Some(id) = path.strip_prefix(&format!("{sidecar_base}/")) {
                            return match state.sidecars.get(id).cloned() {
                                Some(item) => ResponseTemplate::new(200).set_body_json(item),
                                None => ResponseTemplate::new(404)
                                    .set_body_json(json!({"error": {"code": "not_found"}})),
                            };
                        }
                        if let Some(id) = path.strip_prefix(&format!("{public_base}/")) {
                            return match state.incidents.get(id).cloned() {
                                Some(item) => ResponseTemplate::new(200).set_body_json(item),
                                None => ResponseTemplate::new(404)
                                    .set_body_json(json!({"error": {"code": "not_found"}})),
                            };
                        }
                    }
                    if method == "POST" && path == sidecar_base {
                        if state
                            .backup_dir
                            .as_ref()
                            .is_some_and(|directory| !directory.join("manifest.json").exists())
                        {
                            state.mutation_before_backup = true;
                        }
                        let body = state
                            .requests
                            .last()
                            .and_then(|request| request.body.clone());
                        let Some(body) = body else {
                            return ResponseTemplate::new(400)
                                .set_body_json(json!({"error": {"code": "invalid_body"}}));
                        };
                        let Some(id) = body.get("id").and_then(Value::as_str) else {
                            return ResponseTemplate::new(400)
                                .set_body_json(json!({"error": {"code": "id_required"}}));
                        };
                        if state.sidecars.contains_key(id) {
                            return ResponseTemplate::new(409)
                                .set_body_json(json!({"error": {"code": "version_conflict"}}));
                        }
                        let Some(data) = body.get("data").cloned() else {
                            return ResponseTemplate::new(400)
                                .set_body_json(json!({"error": {"code": "data_required"}}));
                        };
                        let item = test_record(id, 1, data);
                        state.sidecars.insert(id.to_string(), item.clone());
                        return ResponseTemplate::new(200).set_body_json(item);
                    }
                    if method == "PATCH" {
                        let (is_sidecar, id) =
                            if let Some(id) = path.strip_prefix(&format!("{sidecar_base}/")) {
                                (true, id)
                            } else if let Some(id) = path.strip_prefix(&format!("{public_base}/")) {
                                (false, id)
                            } else {
                                return ResponseTemplate::new(404)
                                    .set_body_json(json!({"error": {"code": "not_found"}}));
                            };
                        if state
                            .backup_dir
                            .as_ref()
                            .is_some_and(|directory| !directory.join("manifest.json").exists())
                        {
                            state.mutation_before_backup = true;
                        }
                        let body = state
                            .requests
                            .last()
                            .and_then(|request| request.body.clone());
                        let Some(body) = body else {
                            return ResponseTemplate::new(400)
                                .set_body_json(json!({"error": {"code": "invalid_body"}}));
                        };
                        let current = if is_sidecar {
                            state.sidecars.get(id).cloned()
                        } else {
                            state.incidents.get(id).cloned()
                        };
                        let Some(current) = current else {
                            return ResponseTemplate::new(404)
                                .set_body_json(json!({"error": {"code": "not_found"}}));
                        };
                        let conflict_patch = if is_sidecar {
                            state.sidecar_conflict_patch.clone()
                        } else {
                            state.public_conflict_patch.clone()
                        };
                        let conflicts = if is_sidecar {
                            &mut state.sidecar_conflicts
                        } else {
                            &mut state.public_conflicts
                        };
                        if *conflicts > 0 {
                            *conflicts -= 1;
                            let mut concurrent = current;
                            if let Some(data) = concurrent.data.as_object_mut() {
                                for (key, value) in conflict_patch {
                                    data.insert(key, value);
                                }
                            }
                            concurrent.version += 1;
                            if is_sidecar {
                                state.sidecars.insert(id.to_string(), concurrent);
                            } else {
                                state.incidents.insert(id.to_string(), concurrent);
                            }
                            return ResponseTemplate::new(409)
                                .set_body_json(json!({"error": {"code": "version_conflict"}}));
                        }
                        let Some(expected) = body.get("ifVersion").and_then(Value::as_i64) else {
                            return ResponseTemplate::new(400)
                                .set_body_json(json!({"error": {"code": "ifVersion_required"}}));
                        };
                        if expected != current.version {
                            return ResponseTemplate::new(409)
                                .set_body_json(json!({"error": {"code": "version_conflict"}}));
                        }
                        let Some(data) = body.get("data").cloned() else {
                            return ResponseTemplate::new(400)
                                .set_body_json(json!({"error": {"code": "data_required"}}));
                        };
                        let mut updated = current;
                        updated.data = data;
                        updated.version += 1;
                        updated.updated_at = now_iso();
                        if is_sidecar {
                            state.sidecars.insert(id.to_string(), updated.clone());
                        } else {
                            state.incidents.insert(id.to_string(), updated.clone());
                        }
                        return ResponseTemplate::new(200).set_body_json(updated);
                    }
                    ResponseTemplate::new(404)
                        .set_body_json(json!({"error": {"code": "mock_not_found"}}))
                })
                .mount(server)
                .await;
        }
    }

    fn test_record(id: &str, version: i64, data: Value) -> RecordItem {
        RecordItem {
            id: id.into(),
            data,
            version,
            published: None,
            created_at: "2026-11-01T00:00:00.000Z".into(),
            updated_at: "2026-11-01T00:00:00.000Z".into(),
        }
    }

    fn legacy_incident() -> RecordItem {
        test_record(
            "inc-1",
            3,
            json!({
                "id": "inc-1",
                "title": "Public title",
                "description": "Public description",
                "status": "open",
                "custom_public_field": {"keep": true},
                "reported_by": "private-reporter",
                "reporter_phone": "private-phone",
                "assigned_to": "private-assignee",
                "internal_comments": [{"id": "top-level", "comment": "private-top-level"}],
                "comments": [
                    {"id": "internal-1", "comment": "private-note", "is_internal": true, "user_id": "private-user"},
                    {"id": "public-1", "comment": "Public update", "posted_at": "2026-11-01T00:00:00.000Z", "user_id": "private-user", "user_name": "Hidden Name", "is_internal": false},
                    {"id": "public-2", "comment": "Named public update", "user_name": "Public Name", "public_author": true}
                ]
            }),
        )
    }

    fn clean_incident(id: &str) -> RecordItem {
        test_record(id, 1, json!({"id": id, "title": "Clean", "comments": []}))
    }

    async fn client_for(server: &MockServer) -> Client {
        Client::new(server.uri(), Credentials::api_key(TEST_CREDENTIAL)).expect("mock client")
    }

    fn dry_options() -> Options {
        Options {
            mode: Mode::DryRun,
            backup_dir: None,
        }
    }

    static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = env::temp_dir().join(format!(
                "synapsecity-incident-migration-{label}-{}-{counter}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn public_redaction_is_idempotent() {
        let incident = legacy_incident();
        let data = object_data(&incident).expect("incident data");
        let once = public_record(&data);
        assert!(
            !is_affected(&once),
            "redacted record still affected: {once:?}"
        );
        assert_eq!(public_record(&once), once);
    }

    #[test]
    fn internal_fields_match_the_workflow_generator() {
        let source = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../plugins/workflows/generate-workspace-actions.mjs"),
        )
        .expect("workflow generator");
        let section = source
            .split("const INCIDENT_INTERNAL_FIELDS = [")
            .nth(1)
            .expect("internal field declaration")
            .split("];")
            .next()
            .expect("internal field terminator");
        let fields = section
            .split(',')
            .map(|field| field.trim().trim_matches('\''))
            .filter(|field| !field.is_empty())
            .collect::<Vec<_>>();
        assert_eq!(fields, INTERNAL_FIELDS);
    }

    #[test]
    fn cli_defaults_to_dry_run_and_apply_requires_backup() {
        let parsed = parse_args(Vec::<String>::new()).expect("default options");
        assert_eq!(parsed.expect("options").mode, Mode::DryRun);
        assert!(parse_args(["--apply".into()]).is_err());
        let parsed = parse_args(["--apply".into(), "--backup-dir".into(), "/backup".into()])
            .expect("apply options")
            .expect("options");
        assert_eq!(parsed.mode, Mode::Apply);
        assert_eq!(parsed.backup_dir, Some(PathBuf::from("/backup")));
        assert!(parse_args(["--unknown".into()]).is_err());
    }

    #[test]
    fn endpoint_and_credential_guards_are_fail_closed() {
        assert_eq!(
            public_https_base("https://synapsedx.sbs").expect("public HTTPS"),
            "https://synapsedx.sbs"
        );
        for invalid in [
            "http://synapsedx.sbs",
            "https://localhost",
            "https://127.0.0.1",
            "https://10.0.0.8",
            "https://service.internal",
            "https://user:password@synapsedx.sbs",
            "https://synapsedx.sbs?token=value",
        ] {
            assert!(public_https_base(invalid).is_err(), "must reject {invalid}");
        }
        assert!(valid_credential("test-value"));
        assert!(!valid_credential(""));
        assert!(!valid_credential("test\nvalue"));
    }

    #[test]
    fn sdk_error_values_are_never_reported() {
        let failure = Failure::from_sdk(Error::Api {
            status: 409,
            path: "/private-path".into(),
            message: "private-message".into(),
            code: Some("private-code".into()),
            request_id: "private-request-id".into(),
            details: Some(json!({"private": "value"})),
            body: Some(json!({"private": "body"})),
            base_url: "https://synapsedx.sbs".into(),
        });
        assert_eq!(failure.code, "version_conflict");
        assert_eq!(failure.request_id, None);
        let report = ReportError::new(Some("inc-1"), "sidecar_write", failure);
        let output = serde_json::to_string(&report).expect("error JSON");
        assert!(!output.contains("private-"));
    }

    #[tokio::test]
    async fn dry_run_pages_every_record_and_never_writes() {
        let mut incidents = (0..500)
            .map(|index| clean_incident(&format!("clean-{index:03}")))
            .collect::<Vec<_>>();
        incidents.push(legacy_incident());
        let mock = MockTier2::new(incidents, Vec::new());
        let server = MockServer::start().await;
        mock.mount(&server).await;
        let client = client_for(&server).await;
        let backup = TempDir::new("dry-run");

        let report = run_migration(
            &client,
            Options {
                backup_dir: Some(backup.0.clone()),
                ..dry_options()
            },
        )
        .await;

        assert_eq!(report.status, "ok");
        assert_eq!(report.mode, Mode::DryRun);
        assert_eq!(report.scanned, 501);
        assert_eq!(report.already_clean, 500);
        assert_eq!(report.affected, 1);
        assert_eq!(report.planned_sidecar_creates, 1);
        assert_eq!(report.planned_public_patches, 1);
        assert_eq!(report.backed_up_public_records, 0);
        assert!(
            !backup.0.exists(),
            "dry-run must not create a backup directory"
        );
        let state = mock.state.lock().expect("mock state lock");
        assert!(state.requests.iter().all(|request| request.method == "GET"));
        assert!(state
            .requests
            .iter()
            .all(|request| { request.api_key.as_deref() == Some(TEST_CREDENTIAL) }));
        let list_requests = state
            .requests
            .iter()
            .filter(|request| request.path == records_path(INCIDENTS_DATASET))
            .collect::<Vec<_>>();
        assert_eq!(list_requests.len(), 2);
        assert_eq!(
            list_requests[0].query,
            vec![
                ("limit".into(), "500".into()),
                ("offset".into(), "0".into())
            ]
        );
        assert_eq!(
            list_requests[1].query,
            vec![
                ("limit".into(), "500".into()),
                ("offset".into(), "500".into())
            ]
        );
        let output = serde_json::to_string(&report).expect("report JSON");
        assert!(!output.contains("private-reporter"));
        assert!(!output.contains("private-phone"));
        assert!(!output.contains(TEST_CREDENTIAL));
    }

    #[tokio::test]
    async fn migration_merges_a_legacy_sidecar_and_redacts_the_public_record() {
        let sidecar = test_record(
            "inc-1",
            7,
            json!({
                "id": "inc-1",
                "incident_id": "inc-1",
                "reported_by": "private-reporter",
                "unrelated_sidecar_data": {"retention": "keep"},
                "internal_comments": [{"id": "existing", "comment": "private-existing"}]
            }),
        );
        let original = legacy_incident();
        let mock = MockTier2::new(vec![original], vec![sidecar]);
        let server = MockServer::start().await;
        mock.mount(&server).await;
        let client = client_for(&server).await;

        let report = run_migration(&client, dry_options()).await;
        assert_eq!(report.planned_sidecar_updates, 1);
        let backup = TempDir::new("migration");
        let report = run_migration(
            &client,
            Options {
                mode: Mode::Apply,
                backup_dir: Some(backup.0.clone()),
            },
        )
        .await;

        assert_eq!(report.status, "ok", "{report:?}");
        assert_eq!(report.applied_records, 1);
        assert_eq!(report.sidecars_updated, 1);
        assert_eq!(report.public_records_patched, 1);
        let state = mock.state.lock().expect("mock state lock");
        let public = state.incidents.get("inc-1").expect("public record");
        let public_data = public.data.as_object().expect("public object");
        for field in INTERNAL_FIELDS {
            assert!(
                !public_data.contains_key(field),
                "private field {field} remains"
            );
        }
        assert_eq!(public_data["title"], "Public title");
        assert_eq!(public_data["custom_public_field"], json!({"keep": true}));
        let comments = public_data["comments"].as_array().expect("public comments");
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0]["id"], "public-1");
        assert_eq!(comments[0]["is_internal"], false);
        assert!(comments[0].get("user_id").is_none());
        assert!(comments[0].get("user_name").is_none());
        assert_eq!(comments[1]["user_name"], "Public Name");

        let sidecar = state.sidecars.get("inc-1").expect("legacy sidecar");
        let sidecar_data = sidecar.data.as_object().expect("sidecar object");
        assert_eq!(sidecar.version, 8);
        assert_eq!(sidecar_data["reporter_phone"], "private-phone");
        assert_eq!(sidecar_data["assigned_to"], "private-assignee");
        assert_eq!(
            sidecar_data["unrelated_sidecar_data"],
            json!({"retention": "keep"})
        );
        let internal_comments = sidecar_data["internal_comments"]
            .as_array()
            .expect("internal comments");
        assert_eq!(internal_comments.len(), 3);

        let sidecar_patch = state
            .requests
            .iter()
            .find(|request| request.method == "PATCH" && request.path.contains(SIDECAR_DATASET))
            .expect("sidecar PATCH");
        assert_eq!(
            sidecar_patch
                .body
                .as_ref()
                .and_then(|body| body.get("ifVersion")),
            Some(&json!(7))
        );
        assert_eq!(
            sidecar_patch
                .body
                .as_ref()
                .and_then(|body| body.get("publish")),
            Some(&json!(false))
        );
        let public_patch = state
            .requests
            .iter()
            .find(|request| request.method == "PATCH" && request.path.contains(INCIDENTS_DATASET))
            .expect("public PATCH");
        assert_eq!(
            public_patch
                .body
                .as_ref()
                .and_then(|body| body.get("ifVersion")),
            Some(&json!(3))
        );
        assert!(public_patch
            .body
            .as_ref()
            .and_then(|body| body.get("publish"))
            .is_none());
    }

    #[tokio::test]
    async fn rerun_is_a_noop_after_migration() {
        let mock = MockTier2::new(vec![legacy_incident()], Vec::new());
        let server = MockServer::start().await;
        mock.mount(&server).await;
        let client = client_for(&server).await;
        let first_backup = TempDir::new("rerun-first");
        let first = run_migration(
            &client,
            Options {
                mode: Mode::Apply,
                backup_dir: Some(first_backup.0.clone()),
            },
        )
        .await;
        assert_eq!(first.status, "ok", "{first:?}");
        let writes_before = mock
            .state
            .lock()
            .expect("mock state lock")
            .requests
            .iter()
            .filter(|request| request.method != "GET")
            .count();

        let second_backup = TempDir::new("rerun-second");
        let second = run_migration(
            &client,
            Options {
                mode: Mode::Apply,
                backup_dir: Some(second_backup.0.clone()),
            },
        )
        .await;
        assert_eq!(second.status, "ok", "{second:?}");
        assert_eq!(second.scanned, 1);
        assert_eq!(second.affected, 0);
        assert_eq!(second.already_clean, 1);
        assert_eq!(second.applied_records, 0);
        assert_eq!(second.sidecars_created, 0);
        assert_eq!(second.public_records_patched, 0);
        let state = mock.state.lock().expect("mock state lock");
        let writes_after = state
            .requests
            .iter()
            .filter(|request| request.method != "GET")
            .count();
        assert_eq!(writes_after, writes_before);
    }

    #[tokio::test]
    async fn conflicts_reread_and_retry_with_fresh_versions() {
        let sidecar = test_record(
            "internal-inc-1",
            7,
            json!({"id": "internal-inc-1", "incident_id": "inc-1", "unrelated": "keep"}),
        );
        let mock = MockTier2::new(vec![legacy_incident()], vec![sidecar]);
        {
            let mut state = mock.state.lock().expect("mock state lock");
            state.sidecar_conflicts = 1;
            state
                .sidecar_conflict_patch
                .insert("concurrent_sidecar_field".into(), json!("keep"));
            state.public_conflicts = 1;
            state
                .public_conflict_patch
                .insert("status".into(), json!("investigating"));
            state
                .public_conflict_patch
                .insert("reporter_email".into(), json!("private-concurrent-email"));
        }
        let server = MockServer::start().await;
        mock.mount(&server).await;
        let client = client_for(&server).await;
        let backup = TempDir::new("conflict");

        let report = run_migration(
            &client,
            Options {
                mode: Mode::Apply,
                backup_dir: Some(backup.0.clone()),
            },
        )
        .await;

        assert_eq!(report.status, "ok", "{report:?}");
        assert_eq!(report.conflicts, 2);
        assert_eq!(report.applied_records, 1);
        assert_eq!(report.sidecars_updated, 2);
        assert_eq!(report.public_records_patched, 1);
        let state = mock.state.lock().expect("mock state lock");
        let public = state.incidents["inc-1"]
            .data
            .as_object()
            .expect("public data")
            .clone();
        assert_eq!(public["status"], "investigating");
        assert!(!public.contains_key("reporter_email"));
        let sidecar = state.sidecars["internal-inc-1"]
            .data
            .as_object()
            .expect("sidecar data")
            .clone();
        assert_eq!(sidecar["reporter_email"], "private-concurrent-email");
        assert_eq!(sidecar["concurrent_sidecar_field"], "keep");
        let public_patches = state
            .requests
            .iter()
            .filter(|request| request.method == "PATCH" && request.path.contains(INCIDENTS_DATASET))
            .collect::<Vec<_>>();
        assert_eq!(public_patches.len(), 2);
        assert_eq!(
            public_patches[0]
                .body
                .as_ref()
                .and_then(|body| body.get("ifVersion")),
            Some(&json!(3))
        );
        assert_eq!(
            public_patches[1]
                .body
                .as_ref()
                .and_then(|body| body.get("ifVersion")),
            Some(&json!(4))
        );
    }

    #[tokio::test]
    async fn conflict_retries_are_bounded() {
        let sidecar = test_record(
            "internal-inc-1",
            4,
            json!({"id": "internal-inc-1", "incident_id": "inc-1"}),
        );
        let mock = MockTier2::new(vec![legacy_incident()], vec![sidecar]);
        mock.state
            .lock()
            .expect("mock state lock")
            .sidecar_conflicts = 99;
        let server = MockServer::start().await;
        mock.mount(&server).await;
        let client = client_for(&server).await;
        let backup = TempDir::new("bounded-conflict");

        let report = run_migration(
            &client,
            Options {
                mode: Mode::Apply,
                backup_dir: Some(backup.0.clone()),
            },
        )
        .await;

        assert_eq!(report.status, "error");
        assert_eq!(report.conflicts, MAX_CONFLICT_RETRIES);
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].code, "version_conflict");
        let state = mock.state.lock().expect("mock state lock");
        let sidecar_patches = state
            .requests
            .iter()
            .filter(|request| request.method == "PATCH" && request.path.contains(SIDECAR_DATASET))
            .count();
        assert_eq!(sidecar_patches, MAX_CONFLICT_RETRIES + 1);
        assert!(state
            .requests
            .iter()
            .all(|request| request.method != "PATCH" || request.path.contains(SIDECAR_DATASET)));
    }

    #[tokio::test]
    async fn backups_capture_originals_before_any_mutation() {
        let first = legacy_incident();
        let second = test_record(
            "inc-2",
            2,
            json!({"id": "inc-2", "title": "Second", "reported_by": "private-second"}),
        );
        let existing_sidecar = test_record(
            "internal-inc-2",
            5,
            json!({"id": "internal-inc-2", "incident_id": "inc-2", "unrelated": "keep"}),
        );
        let mock = MockTier2::new(
            vec![first.clone(), second.clone()],
            vec![existing_sidecar.clone()],
        );
        let backup = TempDir::new("backup");
        mock.state.lock().expect("mock state lock").backup_dir = Some(backup.0.clone());
        let server = MockServer::start().await;
        mock.mount(&server).await;
        let client = client_for(&server).await;

        let report = run_migration(
            &client,
            Options {
                mode: Mode::Apply,
                backup_dir: Some(backup.0.clone()),
            },
        )
        .await;

        assert_eq!(report.status, "ok", "{report:?}");
        assert_eq!(report.backed_up_public_records, 2);
        assert_eq!(report.backed_up_sidecars, 1);
        assert!(
            !mock
                .state
                .lock()
                .expect("mock state lock")
                .mutation_before_backup
        );
        {
            let state = mock.state.lock().expect("mock state lock");
            let create = state
                .requests
                .iter()
                .find(|request| request.method == "POST" && request.path.contains(SIDECAR_DATASET))
                .expect("sidecar create");
            let body = create.body.as_ref().expect("create body");
            assert_eq!(body.get("id"), Some(&json!("internal-inc-1")));
            assert_eq!(body.get("publish"), Some(&json!(false)));
        }
        let manifest: BackupManifest =
            serde_json::from_slice(&fs::read(backup.0.join("manifest.json")).expect("manifest"))
                .expect("manifest JSON");
        assert_eq!(manifest.records.len(), 2);
        let first_entry = manifest
            .records
            .iter()
            .find(|entry| entry.incident_id == "inc-1")
            .expect("first backup entry");
        assert!(first_entry.sidecar.is_none());
        let first_backup: RecordItem = serde_json::from_slice(
            &fs::read(backup.0.join(&first_entry.public.file)).expect("public backup"),
        )
        .expect("public backup JSON");
        assert_eq!(first_backup.data, first.data);
        assert_eq!(first_backup.version, first.version);
        let first_bytes = fs::read(backup.0.join(&first_entry.public.file)).expect("public bytes");
        assert_eq!(
            hex_lower(&Sha256::digest(&first_bytes)),
            first_entry.public.sha256
        );
        let second_entry = manifest
            .records
            .iter()
            .find(|entry| entry.incident_id == "inc-2")
            .expect("second backup entry");
        let sidecar_entry = second_entry.sidecar.as_ref().expect("sidecar backup entry");
        let sidecar_backup: RecordItem = serde_json::from_slice(
            &fs::read(backup.0.join(&sidecar_entry.file)).expect("sidecar backup"),
        )
        .expect("sidecar backup JSON");
        assert_eq!(sidecar_backup.data, existing_sidecar.data);
        assert_eq!(sidecar_backup.version, existing_sidecar.version);
        #[cfg(unix)]
        {
            assert_eq!(
                fs::metadata(&backup.0)
                    .expect("backup metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(backup.0.join("manifest.json"))
                    .expect("manifest metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn nonempty_backup_directory_prevents_all_mutations() {
        let mock = MockTier2::new(vec![legacy_incident()], Vec::new());
        let server = MockServer::start().await;
        mock.mount(&server).await;
        let client = client_for(&server).await;
        let backup = TempDir::new("nonempty-backup");
        fs::create_dir_all(&backup.0).expect("backup directory");
        let sentinel = backup.0.join("operator-file");
        fs::write(&sentinel, b"keep").expect("sentinel");

        let report = run_migration(
            &client,
            Options {
                mode: Mode::Apply,
                backup_dir: Some(backup.0.clone()),
            },
        )
        .await;

        assert_eq!(report.status, "error");
        assert_eq!(report.errors[0].code, "backup_directory_not_empty");
        assert_eq!(fs::read(&sentinel).expect("sentinel read"), b"keep");
        let state = mock.state.lock().expect("mock state lock");
        assert!(state.requests.iter().all(|request| request.method == "GET"));
        assert!(state.sidecars.is_empty());
    }

    #[tokio::test]
    async fn conflicting_sidecar_values_abort_before_mutation() {
        let sidecar = test_record(
            "internal-inc-1",
            4,
            json!({
                "id": "internal-inc-1",
                "incident_id": "inc-1",
                "reported_by": "different-private-reporter"
            }),
        );
        let mock = MockTier2::new(vec![legacy_incident()], vec![sidecar]);
        let server = MockServer::start().await;
        mock.mount(&server).await;
        let client = client_for(&server).await;
        let backup = TempDir::new("sidecar-value-conflict");

        let report = run_migration(
            &client,
            Options {
                mode: Mode::Apply,
                backup_dir: Some(backup.0.clone()),
            },
        )
        .await;

        assert_eq!(report.status, "error");
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].code, "sidecar_field_conflict");
        assert_eq!(report.errors[0].field.as_deref(), Some("reported_by"));
        assert!(!backup.0.exists());
        let state = mock.state.lock().expect("mock state lock");
        assert!(state.requests.iter().all(|request| request.method == "GET"));
    }
}
