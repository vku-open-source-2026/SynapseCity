// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! File references and the Tier-2 files capability boundary
//! (port of `src/files.ts`).
//!
//! Binary content lives in Tier-1 object storage, reached through the Tier-2
//! `files` capability. A City record keeps only a stable file id, a City
//! download URL and non-secret metadata. `data:` URLs are rejected on every
//! write path.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{number_from_value, string_value};

pub const FILES_DEPENDENCY: &str = "https://github.com/vku-open-source-2026/SynapseDX/issues/9";

pub const IMAGE_MIME_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

pub const DOCUMENT_MIME_TYPES: [&str; 6] = [
    "application/pdf",
    "text/csv",
    "text/plain",
    "application/json",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

/// Any MIME type a City attachment may carry (photos + documents).
pub const UPLOAD_MIME_TYPES: [&str; 10] = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/pdf",
    "text/csv",
    "text/plain",
    "application/json",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

const MAX_REFERENCE_LENGTH: usize = 2048;
pub const DEFAULT_MAX_BYTES: i64 = 10 * 1024 * 1024;

const INLINE_BINARY_KEYS: [&str; 4] = [
    "content_base64",
    "file_content",
    "fileContent",
    "contentBase64",
];
const FILE_REFERENCE_KEYS: [&str; 8] = [
    "photo",
    "photos",
    "file_url",
    "fileUrl",
    "url",
    "attachments",
    "attachment",
    "file_type",
];
const FILE_NAME_REFERENCE_KEYS: [&str; 1] = ["file_name"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Photo,
    Document,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileError {
    Invalid { code: String, status: u16 },
    CapabilityUnavailable { code: String, dependency: String },
}

impl FileError {
    pub fn code(&self) -> &str {
        match self {
            FileError::Invalid { code, .. } => code,
            FileError::CapabilityUnavailable { code, .. } => code,
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            FileError::Invalid { status, .. } => *status,
            FileError::CapabilityUnavailable { .. } => 503,
        }
    }

    pub fn dependency(&self) -> Option<&str> {
        match self {
            FileError::CapabilityUnavailable { dependency, .. } => Some(dependency),
            FileError::Invalid { .. } => None,
        }
    }
}

impl std::fmt::Display for FileError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for FileError {}

fn invalid(code: &str, status: u16) -> FileError {
    FileError::Invalid {
        code: code.to_string(),
        status,
    }
}

pub fn is_data_url(value: &str) -> bool {
    value.trim().to_lowercase().starts_with("data:")
}

/// Tier-2 0.3.0 publishes the `files` capability, so the adapter is available.
/// Storage/presign availability is reported by the per-call error, never
/// assumed.
pub fn files_capability_available() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesCapabilityStatus {
    pub status: String,
    pub transport: String,
    pub presign: String,
    pub links: Vec<String>,
    pub max_bytes: i64,
    pub allowed_types: Vec<String>,
}

pub fn files_capability_status() -> FilesCapabilityStatus {
    FilesCapabilityStatus {
        status: "available".to_string(),
        transport: "synapsedx".to_string(),
        presign: "optional".to_string(),
        links: vec![
            "POST /v1/files".to_string(),
            "POST /v1/files/upload".to_string(),
            "GET /v1/files/:id/content".to_string(),
            "POST /v1/files/:id/presign".to_string(),
        ],
        max_bytes: file_max_bytes(None),
        allowed_types: UPLOAD_MIME_TYPES
            .iter()
            .map(|mime| (*mime).to_string())
            .collect(),
    }
}

/// Maximum upload size accepted by City before calling Tier-2.
pub fn file_max_bytes(configured: Option<i64>) -> i64 {
    match configured {
        Some(value) if value >= 1024 => value,
        _ => DEFAULT_MAX_BYTES,
    }
}

/// Largest allowed request body on the edge/gateway for a binary upload.
pub fn file_request_limit() -> i64 {
    file_max_bytes(None) + 1024 * 1024
}

pub fn file_request_limit_for(max_bytes: i64) -> i64 {
    max_bytes + 1024 * 1024
}

pub fn file_max_bytes_for(_kind: FileKind, configured: Option<i64>) -> i64 {
    match configured {
        Some(value) if value >= 1024 => value,
        _ => file_max_bytes(None),
    }
}

fn split_scheme(value: &str) -> Option<(&str, &str)> {
    let colon = value.find(':')?;
    let scheme = &value[..colon];
    let mut characters = scheme.chars();
    match characters.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return None,
    }
    if !characters
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.'))
    {
        return None;
    }
    Some((scheme, &value[colon + 1..]))
}

/// Validates an already-stored file reference. Legacy external HTTPS references
/// remain readable; new uploads must use the files capability.
pub fn assert_stored_file_reference(
    value: Option<&Value>,
    field: Option<&str>,
    allow_local_http: bool,
) -> Result<String, FileError> {
    let field = field.unwrap_or("file_url");
    let url = string_value(value).trim().to_string();
    if url.is_empty() {
        return Err(invalid(&format!("{field}_required"), 400));
    }
    if is_data_url(&url) {
        return Err(invalid("data_url_not_supported", 415));
    }
    let lower = url.to_lowercase();
    if lower.starts_with("blob:") || lower.starts_with("file:") || lower.starts_with("javascript:")
    {
        return Err(invalid("unsupported_file_scheme", 415));
    }
    if url.chars().count() > MAX_REFERENCE_LENGTH {
        return Err(invalid("file_url_too_long", 413));
    }
    let Some((scheme, rest)) = split_scheme(&url) else {
        return Err(invalid("file_url_must_be_absolute", 400));
    };
    let scheme = scheme.to_lowercase();
    if let Some(authority_and_path) = rest.strip_prefix("//") {
        let authority_end = authority_and_path
            .find(['/', '?', '#'])
            .unwrap_or(authority_and_path.len());
        if authority_and_path[..authority_end].is_empty() {
            return Err(invalid("file_url_must_be_absolute", 400));
        }
    }
    if scheme == "https" {
        return Ok(url);
    }
    if scheme == "http" && allow_local_http {
        return Ok(url);
    }
    Err(invalid("file_url_must_use_https", 400))
}

pub fn assert_mime_type(value: Option<&Value>, allowlist: &[&str]) -> Result<String, FileError> {
    let mime_type = string_value(value).trim().to_lowercase();
    if mime_type.is_empty() || mime_type.ends_with("/*") {
        return Ok(allowlist
            .first()
            .copied()
            .unwrap_or("application/octet-stream")
            .to_string());
    }
    if !allowlist.contains(&mime_type.as_str()) {
        return Err(invalid("unsupported_file_type", 415));
    }
    Ok(mime_type)
}

/// A bare reference without a scheme is treated as a City/Tier-2 file id.
pub fn looks_like_file_id(value: &str) -> bool {
    let candidate = value.trim();
    if candidate.is_empty() || candidate.contains("://") || candidate.contains('/') {
        return false;
    }
    let length = candidate.len();
    (8..=80).contains(&length)
        && candidate
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

/// Extracts a Tier-2/City file id from a stored City download URL.
pub fn file_id_from_reference(value: &str) -> Option<String> {
    let raw = value.trim();
    if looks_like_file_id(raw) {
        return Some(raw.to_string());
    }
    let pattern = r"/(?:v1/files|v1/public/files|v1/capabilities/files)/([A-Za-z0-9_-]{8,80})(?:/content)?(?:[?#].*)?$";
    let regex = Regex::new(pattern).ok()?;
    regex
        .captures(raw)
        .and_then(|captures| captures.get(1))
        .map(|capture| capture.as_str().to_string())
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        let character = *byte as char;
        if character.is_ascii_alphanumeric()
            || matches!(
                character,
                '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')'
            )
        {
            encoded.push(character);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

pub fn city_file_url(file_id: &str, public: bool, base_url: Option<&str>) -> String {
    let base = base_url
        .filter(|value| !value.is_empty())
        .unwrap_or("https://synapsecity.sbs");
    let prefix = if public {
        "/v1/public/files"
    } else {
        "/v1/files"
    };
    format!(
        "{}{prefix}/{}/content",
        base.trim_end_matches('/'),
        encode_uri_component(file_id)
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadValidation {
    pub filename: String,
    pub content_type: String,
    pub size: i64,
}

/// Validates an upload before any bytes leave City. Filenames are stripped of
/// path separators, MIME types must be on the attachment allow-list, and the
/// size must fit the City limit.
pub fn validate_upload(
    filename: Option<&Value>,
    content_type: Option<&Value>,
    size: Option<&Value>,
    allowlist: Option<&[&str]>,
    max_bytes: Option<i64>,
) -> Result<UploadValidation, FileError> {
    let filename = string_value(filename).trim().to_string();
    if filename.is_empty() {
        return Err(invalid("filename_required", 400));
    }
    if filename.chars().count() > 255 {
        return Err(invalid("filename_too_long", 400));
    }
    if filename == "."
        || filename == ".."
        || filename.chars().any(|character| {
            matches!(character, '/' | '\\') || (character as u32) < 0x20 || character == '\u{7f}'
        })
    {
        return Err(invalid("filename_must_be_plain", 400));
    }

    let allowlist = allowlist.unwrap_or(&UPLOAD_MIME_TYPES);
    let content_type = assert_mime_type(content_type, allowlist)?;
    let max_bytes = match max_bytes {
        Some(value) if value != 0 => value,
        _ => file_max_bytes(None),
    };

    let parsed_size = size.and_then(number_from_value);
    let must_check_integer = match size {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) if text.is_empty() => false,
        Some(_) => true,
    };
    if must_check_integer {
        match parsed_size {
            Some(value) if value.fract() == 0.0 && value >= 0.0 => {}
            _ => return Err(invalid("size_must_be_non_negative_integer", 400)),
        }
    }
    let resolved_size = parsed_size.filter(|value| *value > 0.0).unwrap_or(0.0);
    if resolved_size > max_bytes as f64 {
        return Err(invalid("file_too_large", 413));
    }

    Ok(UploadValidation {
        filename,
        content_type,
        size: resolved_size as i64,
    })
}

pub fn checksum_of(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{:02x}", *byte))
        .collect()
}

pub fn normalize_checksum(value: Option<&Value>) -> Result<Option<String>, FileError> {
    let raw = string_value(value).trim().to_lowercase();
    if raw.is_empty() {
        return Ok(None);
    }
    let valid = raw.len() == 64 && raw.chars().all(|character| character.is_ascii_hexdigit());
    if !valid {
        return Err(invalid("checksum_must_be_sha256_hex", 400));
    }
    Ok(Some(raw))
}

fn is_reference_key(key: &str) -> bool {
    key.is_empty() || FILE_REFERENCE_KEYS.contains(&key) || FILE_NAME_REFERENCE_KEYS.contains(&key)
}

fn is_base64_data_url(value: &str) -> bool {
    Regex::new(r"(?i)^data:[a-z0-9.+/-]+;base64,")
        .map(|regex| regex.is_match(value))
        .unwrap_or(false)
}

fn assert_no_inline_binary_at(value: &Value, path: &str, key_hint: &str) -> Result<(), FileError> {
    match value {
        Value::Null => Ok(()),
        Value::Array(entries) => {
            for (index, entry) in entries.iter().enumerate() {
                assert_no_inline_binary_at(entry, &format!("{path}[{index}]"), key_hint)?;
            }
            Ok(())
        }
        Value::Object(entries) => {
            for (key, entry) in entries {
                assert_no_inline_binary_at(entry, &format!("{path}.{key}"), key)?;
            }
            Ok(())
        }
        Value::String(text) => {
            let trimmed = text.trim();
            if is_reference_key(key_hint) && is_base64_data_url(trimmed) {
                return Err(invalid("data_url_not_supported", 415));
            }
            if INLINE_BINARY_KEYS.contains(&key_hint) && !trimmed.is_empty() {
                return Err(invalid("inline_binary_not_accepted", 415));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Rejects inline binary anywhere in a write payload. This is the final guard
/// that keeps a `data:` URL or base64 body out of every `city-*` record.
pub fn assert_no_inline_binary(value: &Value) -> Result<(), FileError> {
    assert_no_inline_binary_at(value, "payload", "")
}

pub fn file_kind_for(content_type: &str) -> FileKind {
    if IMAGE_MIME_TYPES.contains(&content_type.to_lowercase().as_str()) {
        FileKind::Photo
    } else {
        FileKind::Document
    }
}

/// Rejects raw uploads with a typed capability error rather than a fake success.
pub fn reject_raw_upload(kind: FileKind) -> FileError {
    FileError::CapabilityUnavailable {
        code: match kind {
            FileKind::Photo => "photo_upload_capability_unavailable",
            FileKind::Document => "document_upload_capability_unavailable",
        }
        .to_string(),
        dependency: FILES_DEPENDENCY.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mime_lists_cover_photos_and_documents() {
        assert_eq!(IMAGE_MIME_TYPES.len(), 4);
        assert_eq!(DOCUMENT_MIME_TYPES.len(), 6);
        assert_eq!(UPLOAD_MIME_TYPES.len(), 10);
        assert_eq!(file_kind_for("IMAGE/PNG"), FileKind::Photo);
        assert_eq!(file_kind_for("application/pdf"), FileKind::Document);
        assert_eq!(
            assert_mime_type(None, &IMAGE_MIME_TYPES).unwrap(),
            "image/png"
        );
        assert_eq!(
            assert_mime_type(Some(&json!("image/*")), &IMAGE_MIME_TYPES).unwrap(),
            "image/png"
        );
        let error =
            assert_mime_type(Some(&json!("application/x-sh")), &UPLOAD_MIME_TYPES).unwrap_err();
        assert_eq!(error.code(), "unsupported_file_type");
        assert_eq!(error.status(), 415);
    }

    #[test]
    fn stored_reference_validation_rejects_data_and_non_https_urls() {
        assert_eq!(
            assert_stored_file_reference(
                Some(&json!("https://city.test/v1/files/abc/content")),
                None,
                false
            )
            .unwrap(),
            "https://city.test/v1/files/abc/content"
        );
        assert_eq!(
            assert_stored_file_reference(Some(&json!("data:image/png;base64,abc")), None, false)
                .unwrap_err()
                .code(),
            "data_url_not_supported"
        );
        assert_eq!(
            assert_stored_file_reference(Some(&json!("http://city.test/file")), None, false)
                .unwrap_err()
                .code(),
            "file_url_must_use_https"
        );
        assert_eq!(
            assert_stored_file_reference(Some(&json!("http://localhost/file")), None, true)
                .unwrap(),
            "http://localhost/file"
        );
        assert_eq!(
            assert_stored_file_reference(Some(&json!("not a url")), Some("photo"), false)
                .unwrap_err()
                .code(),
            "file_url_must_be_absolute"
        );
        assert_eq!(
            assert_stored_file_reference(None, Some("photo"), false)
                .unwrap_err()
                .code(),
            "photo_required"
        );
    }

    #[test]
    fn file_ids_and_city_urls_are_derived_from_references() {
        assert!(looks_like_file_id("abcdefgh"));
        assert!(!looks_like_file_id("abc"));
        assert!(!looks_like_file_id("abc/defgh"));
        assert_eq!(
            file_id_from_reference("https://city.test/v1/files/abcDEF123/content?x=1").as_deref(),
            Some("abcDEF123")
        );
        assert_eq!(
            file_id_from_reference("https://city.test/v1/public/files/abcdefgh/content").as_deref(),
            Some("abcdefgh")
        );
        assert_eq!(file_id_from_reference("https://city.test/nope"), None);
        assert_eq!(
            city_file_url("abcDEF123", false, Some("https://city.test/")),
            "https://city.test/v1/files/abcDEF123/content"
        );
        assert_eq!(
            city_file_url("abcDEF123", true, None),
            "https://synapsecity.sbs/v1/public/files/abcDEF123/content"
        );
    }

    #[test]
    fn uploads_are_validated_before_bytes_leave_city() {
        let valid = validate_upload(
            Some(&json!("lamp.png")),
            Some(&json!("image/png")),
            Some(&json!(12)),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            valid,
            UploadValidation {
                filename: "lamp.png".to_string(),
                content_type: "image/png".to_string(),
                size: 12
            }
        );
        assert_eq!(
            validate_upload(
                Some(&json!("../lamp.png")),
                Some(&json!("image/png")),
                Some(&json!(1)),
                None,
                None
            )
            .unwrap_err()
            .code(),
            "filename_must_be_plain"
        );
        assert_eq!(
            validate_upload(
                Some(&json!("run.sh")),
                Some(&json!("application/x-sh")),
                Some(&json!(1)),
                None,
                None
            )
            .unwrap_err()
            .status(),
            415
        );
        assert_eq!(
            validate_upload(
                Some(&json!("big.png")),
                Some(&json!("image/png")),
                Some(&json!(3 * 1024 * 1024)),
                None,
                Some(2 * 1024 * 1024)
            )
            .unwrap_err()
            .status(),
            413
        );
        assert_eq!(
            validate_upload(
                Some(&json!("x.png")),
                Some(&json!("image/png")),
                Some(&json!(1.5)),
                None,
                None
            )
            .unwrap_err()
            .code(),
            "size_must_be_non_negative_integer"
        );
    }

    #[test]
    fn checksums_are_sha256_hex_and_normalized() {
        assert_eq!(
            checksum_of(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(
            normalize_checksum(Some(&json!(
                "2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824"
            )))
            .unwrap()
            .as_deref(),
            Some("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
        );
        assert_eq!(normalize_checksum(None).unwrap(), None);
        assert_eq!(
            normalize_checksum(Some(&json!("nope"))).unwrap_err().code(),
            "checksum_must_be_sha256_hex"
        );
    }

    #[test]
    fn inline_binary_guard_rejects_data_urls_and_base64_fields() {
        assert_no_inline_binary(
            &json!({ "photos": ["https://city.test/v1/files/abcdefgh/content"] }),
        )
        .unwrap();
        assert_eq!(
            assert_no_inline_binary(&json!({
                "photos": ["data:image/png;base64,iVBORw0KGgo="]
            }))
            .unwrap_err()
            .code(),
            "data_url_not_supported"
        );
        assert_eq!(
            assert_no_inline_binary(&json!({ "content_base64": "aGVsbG8=" }))
                .unwrap_err()
                .code(),
            "inline_binary_not_accepted"
        );
        assert_eq!(
            assert_no_inline_binary(&json!({
                "attachments": [{ "file_url": "data:application/pdf;base64,JVBERi0=" }]
            }))
            .unwrap_err()
            .code(),
            "data_url_not_supported"
        );
        // Data URLs under unrelated keys are not reference fields.
        assert_no_inline_binary(&json!({ "note": "data:text/plain;base64,x" })).unwrap();
    }

    #[test]
    fn capability_helpers_report_real_availability() {
        assert!(files_capability_available());
        let status = files_capability_status();
        assert_eq!(status.status, "available");
        assert_eq!(status.max_bytes, DEFAULT_MAX_BYTES);
        assert_eq!(status.allowed_types.len(), 10);
        assert_eq!(file_max_bytes(Some(2048)), 2048);
        assert_eq!(file_max_bytes(Some(10)), DEFAULT_MAX_BYTES);
        let error = reject_raw_upload(FileKind::Photo);
        assert_eq!(error.status(), 503);
        assert_eq!(error.code(), "photo_upload_capability_unavailable");
        assert_eq!(error.dependency(), Some(FILES_DEPENDENCY));
    }
}
