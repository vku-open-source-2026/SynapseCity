// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Minimal RFC 4180 CSV parser (port of `src/csv.ts`).
//!
//! Supports quoted fields, escaped double quotes, LF/CRLF line endings and a
//! UTF-8 BOM. It stays dependency-free so the City service can ingest the CSV
//! files the console uploads without adding a multipart parser.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::JsonMap;

pub const REQUIRED_ASSET_COLUMNS: [&str; 6] = [
    "asset_code",
    "name",
    "feature_type",
    "feature_code",
    "latitude",
    "longitude",
];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ParsedCsv {
    pub headers: Vec<String>,
    pub rows: Vec<JsonMap>,
}

/// Parses a CSV document into lower-cased, trimmed headers and row records.
pub fn parse_csv(input: &str) -> ParsedCsv {
    let text = input.strip_prefix('\u{feff}').unwrap_or(input);
    let characters: Vec<char> = text.chars().collect();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut field = String::new();
    let mut row: Vec<String> = Vec::new();
    let mut quoted = false;

    let mut index = 0usize;
    while index < characters.len() {
        let character = characters[index];
        if quoted {
            if character == '"' {
                if characters.get(index + 1) == Some(&'"') {
                    field.push('"');
                    index += 1;
                } else {
                    quoted = false;
                }
            } else {
                field.push(character);
            }
            index += 1;
            continue;
        }
        if character == '"' {
            quoted = true;
            index += 1;
            continue;
        }
        if character == ',' {
            row.push(std::mem::take(&mut field));
            index += 1;
            continue;
        }
        if character == '\n' || character == '\r' {
            if character == '\r' && characters.get(index + 1) == Some(&'\n') {
                index += 1;
            }
            row.push(std::mem::take(&mut field));
            if row.iter().any(|value| !value.trim().is_empty()) {
                rows.push(std::mem::take(&mut row));
            } else {
                row.clear();
            }
            index += 1;
            continue;
        }
        field.push(character);
        index += 1;
    }

    if !field.is_empty() || !row.is_empty() {
        row.push(std::mem::take(&mut field));
        if row.iter().any(|value| !value.trim().is_empty()) {
            rows.push(row);
        }
    }

    if rows.is_empty() {
        return ParsedCsv::default();
    }

    let headers: Vec<String> = rows[0]
        .iter()
        .map(|header| header.trim().to_lowercase())
        .collect();
    let records = rows
        .iter()
        .skip(1)
        .map(|values| {
            let mut record = JsonMap::new();
            for (column, header) in headers.iter().enumerate() {
                let value = values
                    .get(column)
                    .map(|value| value.trim().to_string())
                    .unwrap_or_default();
                record.insert(header.clone(), Value::String(value));
            }
            record
        })
        .collect();

    ParsedCsv {
        headers,
        rows: records,
    }
}

/// Reports which required columns are missing (case-insensitive).
pub fn missing_columns<S: AsRef<str>>(headers: &[S], required: &[&str]) -> Vec<String> {
    let present: HashSet<String> = headers
        .iter()
        .map(|header| header.as_ref().trim().to_lowercase())
        .collect();
    required
        .iter()
        .filter(|column| !present.contains(&column.to_lowercase()))
        .map(|column| (*column).to_string())
        .collect()
}

/// Convenience wrapper using the asset-ingest required column list.
pub fn missing_asset_columns<S: AsRef<str>>(headers: &[S]) -> Vec<String> {
    missing_columns(headers, &REQUIRED_ASSET_COLUMNS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell<'a>(row: &'a JsonMap, key: &str) -> &'a str {
        row.get(key).and_then(Value::as_str).unwrap_or("")
    }

    #[test]
    fn parses_headers_quoted_fields_and_crlf_rows() {
        let parsed = parse_csv(
            "\u{feff}asset_code,name,address,properties\r\nA-1,\"Lamp, main\",\"1 \"\"Main\"\" St\",\"{\"\"lumens\"\":1200}\"\r\nA-2,Hydrant,2 Main St,{}\r\n",
        );
        assert_eq!(
            parsed.headers,
            vec!["asset_code", "name", "address", "properties"]
        );
        assert_eq!(parsed.rows.len(), 2);
        assert_eq!(cell(&parsed.rows[0], "name"), "Lamp, main");
        assert_eq!(cell(&parsed.rows[0], "address"), "1 \"Main\" St");
        assert_eq!(cell(&parsed.rows[0], "properties"), "{\"lumens\":1200}");
        assert_eq!(cell(&parsed.rows[1], "asset_code"), "A-2");
    }

    #[test]
    fn ignores_blank_lines_and_trailing_separators() {
        let parsed = parse_csv("asset_code,name\n\nA-1,Lamp\n\n");
        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(cell(&parsed.rows[0], "name"), "Lamp");
    }

    #[test]
    fn returns_empty_output_for_an_empty_document() {
        assert_eq!(parse_csv(""), ParsedCsv::default());
        assert_eq!(parse_csv("\n\r\n"), ParsedCsv::default());
    }

    #[test]
    fn missing_columns_reports_required_csv_columns() {
        assert_eq!(
            missing_columns(&["asset_code", "name"], &REQUIRED_ASSET_COLUMNS),
            vec!["feature_type", "feature_code", "latitude", "longitude"]
        );
        assert!(missing_columns(&REQUIRED_ASSET_COLUMNS, &REQUIRED_ASSET_COLUMNS).is_empty());
        assert!(missing_asset_columns(&[
            "ASSET_CODE",
            " name ",
            "feature_type",
            "feature_code",
            "latitude",
            "longitude"
        ])
        .is_empty());
    }
}
