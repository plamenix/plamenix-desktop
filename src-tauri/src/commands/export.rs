//! Server-streamed export commands.
//!
//! Runs the user's statement (or, for full-database scope, one SELECT
//! per base table), builds the formatted output server-side, then
//! emits the bytes to the frontend in 64 KiB UTF-8-safe chunks via
//! Tauri events:
//!
//!   - `export:chunk` — payload `{ exportId, seq, text }`
//!   - `export:done`  — payload `{ exportId, totalBytes }`
//!   - `export:err`   — payload `{ exportId, error }`
//!
//! The command itself returns the `export_id` as soon as it has
//! something to emit, so the frontend can wire the listener before
//! the first chunk arrives.

use plamenix_db::export::{format_csv, format_json, format_sql, format_xml, CsvDelimiter, ExportPart};
use plamenix_db::{DbDriver, QueryResult, SessionId};
use plamenix_types::TableInfo;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::db::DbState;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    Sql,
    Xml,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportDelimiter {
    Comma,
    Semicolon,
    Tab,
}

impl From<ExportDelimiter> for CsvDelimiter {
    fn from(d: ExportDelimiter) -> Self {
        match d {
            ExportDelimiter::Comma => CsvDelimiter::Comma,
            ExportDelimiter::Semicolon => CsvDelimiter::Semicolon,
            ExportDelimiter::Tab => CsvDelimiter::Tab,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportScope {
    /// Single statement (typically the user's current result).
    Statement {
        sql: String,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        table: Option<TableInfo>,
    },
    /// One row set per supplied table (the schema's base tables).
    Tables { tables: Vec<TableInfo> },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub session_id: SessionId,
    pub format: ExportFormat,
    #[serde(default = "default_delim")]
    pub csv_delimiter: ExportDelimiter,
    pub scope: ExportScope,
    #[serde(default = "default_include_ddl")]
    pub include_ddl: bool,
}

fn default_delim() -> ExportDelimiter {
    ExportDelimiter::Comma
}

fn default_include_ddl() -> bool {
    true
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportChunk {
    export_id: String,
    seq: usize,
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportDone {
    export_id: String,
    total_bytes: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportErr {
    export_id: String,
    error: String,
}

/// Roughly 64 KiB per chunk. Boundary is UTF-8-aware so a multi-byte
/// codepoint is never split across two chunks.
const CHUNK_BYTES: usize = 64 * 1024;

fn chunk_utf8(s: &str, max_bytes: usize) -> Vec<String> {
    if s.len() <= max_bytes {
        return if s.is_empty() {
            Vec::new()
        } else {
            vec![s.to_string()]
        };
    }
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut bytes = 0usize;
    for c in s.chars() {
        let len = c.len_utf8();
        if bytes + len > max_bytes && !buf.is_empty() {
            out.push(std::mem::take(&mut buf));
            bytes = 0;
        }
        buf.push(c);
        bytes += len;
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

fn quote_table_ident(name: &str) -> String {
    if name
        .chars()
        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !name.is_empty()
        && !name.chars().next().is_some_and(|c| c.is_ascii_digit())
    {
        name.to_string()
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

#[tauri::command]
#[tracing::instrument(
    name = "db.export",
    skip(app, state, request),
    fields(format = ?request.format),
)]
pub async fn db_export(
    app: AppHandle,
    state: State<'_, DbState>,
    request: ExportRequest,
) -> Result<String, String> {
    let export_id = Uuid::new_v4().to_string();
    let driver = state.driver();
    let session = request.session_id;
    let format = request.format;
    let delim: CsvDelimiter = request.csv_delimiter.into();
    let include_ddl = request.include_ddl;

    // Collect statements + their schema metadata for downstream
    // formatting. Each entry: (table_meta?, label?, columns, rows).
    let mut owned: Vec<(Option<TableInfo>, Option<String>, plamenix_db::QueryResult)> = Vec::new();
    let stmts: Vec<(Option<TableInfo>, Option<String>, String)> = match request.scope {
        ExportScope::Statement { sql, label, table } => vec![(table, label, sql)],
        ExportScope::Tables { tables } => tables
            .into_iter()
            .map(|t| {
                let sql = format!("SELECT * FROM {}", quote_table_ident(&t.name));
                let label = Some(t.name.clone());
                (Some(t), label, sql)
            })
            .collect(),
    };

    for (table, label, sql) in stmts {
        let result = match driver.execute(session, sql).await {
            Ok(r) => r,
            Err(e) => {
                let err = e.to_string();
                let _ = app.emit(
                    "export:err",
                    ExportErr { export_id: export_id.clone(), error: err.clone() },
                );
                return Err(err);
            }
        };
        owned.push((table, label, result));
    }

    // Extract Rows variants up front so we can lend `&[Column]` /
    // `&[Row]` references to ExportPart without re-iterating.
    let mut row_payloads: Vec<(Option<TableInfo>, Option<String>, Vec<plamenix_db::Column>, Vec<plamenix_db::Row>)> = Vec::with_capacity(owned.len());
    for (table, label, qr) in owned {
        match qr {
            QueryResult::Rows { columns, rows, .. } => {
                row_payloads.push((table, label, columns, rows));
            }
            QueryResult::Affected { .. } => {
                // Skip non-row statements silently — they have no body
                // to export.
            }
        }
    }
    let parts: Vec<ExportPart<'_>> = row_payloads
        .iter()
        .map(|(table, label, columns, rows)| ExportPart {
            table: table.as_ref(),
            label: label.clone(),
            columns,
            rows,
        })
        .collect();

    let output = match format {
        ExportFormat::Csv => format_csv(&parts, delim),
        ExportFormat::Json => format_json(&parts),
        ExportFormat::Sql => format_sql(&parts, include_ddl),
        ExportFormat::Xml => format_xml(&parts),
    };

    let total_bytes = output.len();
    let chunks = chunk_utf8(&output, CHUNK_BYTES);
    for (seq, text) in chunks.into_iter().enumerate() {
        let payload = ExportChunk {
            export_id: export_id.clone(),
            seq,
            text,
        };
        if let Err(err) = app.emit("export:chunk", payload) {
            tracing::warn!(?err, "failed to emit export:chunk");
        }
    }
    if let Err(err) = app.emit(
        "export:done",
        ExportDone { export_id: export_id.clone(), total_bytes },
    ) {
        tracing::warn!(?err, "failed to emit export:done");
    }

    Ok(export_id)
}
