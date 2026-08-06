//! Tauri commands for talking to Firebird via `plamenix-db`.
//!
//! Each command is a thin adapter: parse the inbound argument shape,
//! call into the shared `DbDriver`, and return a serialisable result.
//! No business logic lives here.

use std::path::PathBuf;
use std::time::Instant;

use plamenix_db::{
    ColumnValue, ConnectMode, ConnectionConfig, CryptState, DbDriver, QueryResult, Schema,
    SessionId, StatementOutcome, TxConfig, TxMode, TxStatus, accepts_row_limit, inject_row_limit,
    split_statements,
};
use plamenix_types::{
    DatabaseAlias, DatabaseStats, HistoryEntry, ListAliasesResult, TestConnectionResult,
};

/// Hard cap on rows surfaced to the UI per SELECT statement. Bigger
/// result sets blow memory and serialization time; the user sees a
/// "truncated" hint and can rerun without the cap when really needed.
const ROW_LIMIT: u32 = 10_000;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::db::DbState;
use crate::fbclient::bundled_path;
use crate::history::HistoryStore;

/// Substitutes the bundled fbclient when the caller did not supply
/// one and native mode is in effect. Pure-Rust attaches skip this
/// since rsfbclient's pure-Rust backend never loads a native library.
fn apply_fbclient_fallback(
    config: &mut plamenix_db::ConnectionConfig,
    pure_rust: bool,
    app: &AppHandle,
) {
    if pure_rust {
        return;
    }
    if config.fbclient_path.is_some() {
        return;
    }
    if let Some(path) = bundled_path(app) {
        config.fbclient_path = Some(path.to_string_lossy().into_owned());
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    #[serde(flatten)]
    config: ConnectionConfig,
    #[serde(default)]
    pure_rust: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResponse {
    session_id: SessionId,
}

#[tauri::command]
#[tracing::instrument(
    name = "cmd.db_connect",
    skip(state, request),
    fields(
        host = %request.config.host,
        database = %request.config.database,
        pure_rust = request.pure_rust,
    ),
)]
pub async fn db_connect(
    app: AppHandle,
    state: State<'_, DbState>,
    request: ConnectRequest,
) -> Result<ConnectResponse, String> {
    let mode = if request.pure_rust {
        ConnectMode::PureRust
    } else {
        ConnectMode::Native
    };
    let mut config = request.config;
    apply_fbclient_fallback(&mut config, request.pure_rust, &app);
    state
        .driver()
        .connect(config, mode)
        .await
        .map(|session_id| ConnectResponse { session_id })
        .map_err(|err| err.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteRequest {
    session_id: SessionId,
    sql: String,
    /// When present, each executed statement is appended to the
    /// per-profile history store. Manual / profile-less connections
    /// pass `null` and skip persistence.
    #[serde(default)]
    profile_id: Option<String>,
    /// Per-profile retention cap. `None` (or `null` on the wire) means
    /// unlimited — no trim runs after the insert. Positive values cause
    /// the store to drop entries older than the most recent `N`.
    #[serde(default)]
    history_limit: Option<i64>,
}

#[tauri::command]
#[tracing::instrument(
    name = "cmd.db_execute",
    skip(db, history, request),
    fields(
        session = %request.session_id.0,
        sql_len = request.sql.len(),
        profile = request.profile_id.as_deref().unwrap_or(""),
    ),
)]
pub async fn db_execute(
    db: State<'_, DbState>,
    history: State<'_, HistoryStore>,
    request: ExecuteRequest,
) -> Result<Vec<StatementOutcome>, String> {
    let stmts = split_statements(&request.sql);
    if stmts.is_empty() {
        return Err("No executable statements in the buffer.".to_string());
    }
    let driver = db.driver();
    let session_id = request.session_id;
    let profile_id = request.profile_id.as_deref();
    let history_limit = request.history_limit;
    let mut outcomes = Vec::with_capacity(stmts.len());
    for sql in stmts {
        let started = Instant::now();
        // `accepts_row_limit`, not "does this return rows": Firebird's
        // ROWS clause belongs to the SELECT grammar, so appending it to
        // an EXECUTE BLOCK or EXECUTE PROCEDURE is a syntax error.
        let exec_sql = if accepts_row_limit(&sql) {
            inject_row_limit(&sql, ROW_LIMIT)
        } else {
            sql.clone()
        };
        match driver.execute(session_id, exec_sql).await {
            Ok(mut result) => {
                if let QueryResult::Rows {
                    rows, truncated, ..
                } = &mut result
                {
                    if rows.len() > ROW_LIMIT as usize {
                        rows.truncate(ROW_LIMIT as usize);
                        *truncated = true;
                    }
                }
                let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
                if let Some(pid) = profile_id {
                    let row_count = match &result {
                        QueryResult::Rows { rows, .. } => Some(rows.len() as i64),
                        QueryResult::Affected { rows } => Some(*rows as i64),
                    };
                    if let Err(e) =
                        history.record(pid, &sql, duration_ms, "ok", None, row_count, history_limit)
                    {
                        tracing::warn!(?e, "history record failed");
                    }
                }
                outcomes.push(StatementOutcome::Ok {
                    sql,
                    result,
                    duration_ms,
                });
            }
            Err(err) => {
                let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
                let error_text = err.to_string();
                if let Some(pid) = profile_id {
                    if let Err(e) = history.record(
                        pid,
                        &sql,
                        duration_ms,
                        "err",
                        Some(&error_text),
                        None,
                        history_limit,
                    ) {
                        tracing::warn!(?e, "history record failed");
                    }
                }
                outcomes.push(StatementOutcome::Err {
                    sql,
                    error: error_text,
                    duration_ms,
                });
                break;
            }
        }
    }
    Ok(outcomes)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListRequest {
    profile_id: String,
    #[serde(default = "default_history_limit")]
    limit: i64,
}

fn default_history_limit() -> i64 {
    200
}

#[tauri::command]
pub fn history_list(
    history: State<'_, HistoryStore>,
    request: HistoryListRequest,
) -> Result<Vec<HistoryEntry>, String> {
    history.list(&request.profile_id, request.limit)
}

#[tauri::command]
pub fn history_clear(history: State<'_, HistoryStore>, profile_id: String) -> Result<u64, String> {
    history.clear(&profile_id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySetLabelRequest {
    id: i64,
    /// `None` (or `null` on the wire) clears the label. Trimmed
    /// server-side; a whitespace-only value is treated as a clear.
    #[serde(default)]
    label: Option<String>,
}

#[tauri::command]
pub fn history_set_label(
    history: State<'_, HistoryStore>,
    request: HistorySetLabelRequest,
) -> Result<bool, String> {
    history.set_label(request.id, request.label.as_deref())
}

#[tauri::command]
pub fn history_delete(history: State<'_, HistoryStore>, id: i64) -> Result<bool, String> {
    history.delete(id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDeleteManyRequest {
    ids: Vec<i64>,
}

#[tauri::command]
pub fn history_delete_many(
    history: State<'_, HistoryStore>,
    request: HistoryDeleteManyRequest,
) -> Result<u64, String> {
    history.delete_many(&request.ids)
}

#[tauri::command]
#[tracing::instrument(name = "cmd.db_ping", skip(state), fields(session = %session_id.0))]
pub async fn db_ping(state: State<'_, DbState>, session_id: SessionId) -> Result<String, String> {
    state
        .driver()
        .ping(session_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[tracing::instrument(name = "cmd.db_close", skip(state), fields(session = %session_id.0))]
pub async fn db_close(state: State<'_, DbState>, session_id: SessionId) -> Result<(), String> {
    state
        .driver()
        .close(session_id)
        .await
        .map_err(|err| err.to_string())
}

/// Switches a session between autocommit and manual commit.
///
/// Refused while a transaction is open — the caller must commit or roll
/// back first, so no work is silently discarded or silently committed
/// by a mode change.
#[tauri::command]
#[tracing::instrument(name = "cmd.db_set_transaction_mode", skip(state), fields(session = %session_id.0, ?mode))]
pub async fn db_set_transaction_mode(
    state: State<'_, DbState>,
    session_id: SessionId,
    mode: TxMode,
    config: TxConfig,
) -> Result<TxStatus, String> {
    state
        .driver()
        .set_transaction_mode(session_id, mode, config)
        .await
        .map_err(|err| err.to_string())
}

/// Opens an explicit transaction. Manual mode opens one on the first
/// statement, so this is only for starting one deliberately.
#[tauri::command]
#[tracing::instrument(name = "cmd.db_begin_transaction", skip(state), fields(session = %session_id.0))]
pub async fn db_begin_transaction(
    state: State<'_, DbState>,
    session_id: SessionId,
) -> Result<TxStatus, String> {
    state
        .driver()
        .begin_transaction(session_id)
        .await
        .map_err(|err| err.to_string())
}

/// Commits the open transaction.
#[tauri::command]
#[tracing::instrument(name = "cmd.db_commit", skip(state), fields(session = %session_id.0))]
pub async fn db_commit(
    state: State<'_, DbState>,
    session_id: SessionId,
) -> Result<TxStatus, String> {
    state
        .driver()
        .commit(session_id)
        .await
        .map_err(|err| err.to_string())
}

/// Rolls back the open transaction, discarding every statement since it
/// opened — DDL included.
#[tauri::command]
#[tracing::instrument(name = "cmd.db_rollback", skip(state), fields(session = %session_id.0))]
pub async fn db_rollback(
    state: State<'_, DbState>,
    session_id: SessionId,
) -> Result<TxStatus, String> {
    state
        .driver()
        .rollback(session_id)
        .await
        .map_err(|err| err.to_string())
}

/// Current transaction state. Answered from driver state without
/// touching the engine, so the UI can poll it for the age readout.
#[tauri::command]
#[tracing::instrument(name = "cmd.db_transaction_status", skip(state), fields(session = %session_id.0))]
pub async fn db_transaction_status(
    state: State<'_, DbState>,
    session_id: SessionId,
) -> Result<TxStatus, String> {
    state
        .driver()
        .transaction_status(session_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[tracing::instrument(name = "cmd.db_crypt_state", skip(state), fields(session = %session_id.0))]
pub async fn db_crypt_state(
    state: State<'_, DbState>,
    session_id: SessionId,
) -> Result<CryptState, String> {
    state
        .driver()
        .crypt_state(session_id)
        .await
        .map_err(|err| err.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionRequest {
    #[serde(flatten)]
    config: ConnectionConfig,
    #[serde(default)]
    pure_rust: bool,
}

#[tauri::command]
#[tracing::instrument(
    name = "cmd.db_test_connection",
    skip(state, request),
    fields(host = %request.config.host, database = %request.config.database),
)]
pub async fn db_test_connection(
    app: AppHandle,
    state: State<'_, DbState>,
    request: TestConnectionRequest,
) -> Result<TestConnectionResult, String> {
    let mode = if request.pure_rust {
        ConnectMode::PureRust
    } else {
        ConnectMode::Native
    };
    let driver = state.driver();
    let started = Instant::now();
    let mut config = request.config;
    apply_fbclient_fallback(&mut config, request.pure_rust, &app);
    match driver.connect(config, mode).await {
        Ok(session_id) => {
            let version_sql =
                "SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION') FROM rdb$database";
            let firebird_version = match driver.execute(session_id, version_sql.to_string()).await {
                Ok(QueryResult::Rows { rows, .. }) => rows
                    .first()
                    .and_then(|row| row.cells.first())
                    .and_then(|cell| match cell {
                        ColumnValue::Text(s) => Some(s.trim().to_string()),
                        _ => None,
                    }),
                _ => None,
            };
            let _ = driver.close(session_id).await;
            Ok(TestConnectionResult {
                ok: true,
                firebird_version,
                error: None,
                duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            })
        }
        Err(err) => Ok(TestConnectionResult {
            ok: false,
            firebird_version: None,
            error: Some(err.to_string()),
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        }),
    }
}

#[tauri::command]
#[tracing::instrument(name = "cmd.db_list_aliases")]
pub fn db_list_aliases() -> ListAliasesResult {
    for path in candidate_databases_conf_paths() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            return ListAliasesResult {
                source_path: Some(path.display().to_string()),
                aliases: parse_databases_conf(&text),
            };
        }
    }
    ListAliasesResult {
        source_path: None,
        aliases: Vec::new(),
    }
}

fn candidate_databases_conf_paths() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    v.push("/Library/Frameworks/Firebird.framework/Resources/databases.conf".into());
    v.push("/opt/firebird/databases.conf".into());
    for major in [3u32, 4, 5] {
        v.push(format!("/etc/firebird/{major}/databases.conf").into());
    }
    v.push("C:/Program Files/Firebird/Firebird_5_0/databases.conf".into());
    v.push("C:/Program Files/Firebird/Firebird_4_0/databases.conf".into());
    v.push("C:/Program Files/Firebird/Firebird_3_0/databases.conf".into());
    v
}

/// Parses a Firebird `databases.conf` body and returns the aliases
/// declared in the simple `alias = /path` form.
///
/// Comments (lines beginning with `#`) and blank lines are ignored.
/// The block syntax (`alias = { ... }`) used for per-database tuning
/// is skipped — only the inline form is harvested.
fn parse_databases_conf(text: &str) -> Vec<DatabaseAlias> {
    let mut out = Vec::new();
    // Depth of the `alias = { ... }` block form. Skipping only the
    // opening line was not enough: the body's own `Database = /path`
    // entries then parsed as top-level aliases, so a single block
    // produced a bogus alias named `Database`.
    let mut block_depth = 0usize;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if block_depth > 0 {
            if line.contains('}') {
                block_depth -= 1;
            } else if line.ends_with('{') {
                block_depth += 1;
            }
            continue;
        }
        let Some(eq) = line.find('=') else { continue };
        let alias = line[..eq].trim();
        let path_part = line[eq + 1..].trim();
        if alias.is_empty() || path_part.is_empty() {
            continue;
        }
        if path_part.starts_with('{') {
            // Block form. Per-database settings live inside; the alias
            // itself is not usable as a path, so the whole block is
            // skipped rather than half-read.
            block_depth += 1;
            continue;
        }
        if alias.chars().any(char::is_whitespace) {
            continue;
        }
        out.push(DatabaseAlias {
            alias: alias.to_string(),
            path: path_part.to_string(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::parse_databases_conf;

    #[test]
    fn ignores_comments_and_blank_lines() {
        let conf = "# comment\n\nemployee = /var/firebird/employee.fdb\n";
        let out = parse_databases_conf(conf);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].alias, "employee");
        assert_eq!(out[0].path, "/var/firebird/employee.fdb");
    }

    #[test]
    fn block_body_does_not_leak_as_an_alias() {
        // The body's `Database = /path` line looks exactly like a
        // top-level entry, so skipping only the opening `alias = {`
        // produced a bogus alias named `Database`.
        let conf = "foo = {\n  Database = /tmp/foo.fdb\n  DefaultDbCachePages = 100\n}\nbar = /tmp/bar.fdb\n";
        let out = parse_databases_conf(conf);
        assert_eq!(out.len(), 1, "unexpected aliases: {out:?}");
        assert_eq!(out[0].alias, "bar");
    }

    #[test]
    fn skips_block_form() {
        let conf = "employee = /var/firebird/employee.fdb\nfoo = {\n  Database = /tmp/foo.fdb\n}\nbar = /tmp/bar.fdb\n";
        let out = parse_databases_conf(conf);
        assert_eq!(out.len(), 2);
        assert!(out.iter().any(|a| a.alias == "employee"));
        assert!(out.iter().any(|a| a.alias == "bar"));
    }
}

#[tauri::command]
#[tracing::instrument(
    name = "cmd.db_describe_schema",
    skip(state),
    fields(session = %session_id.0),
)]
pub async fn db_describe_schema(
    state: State<'_, DbState>,
    session_id: SessionId,
) -> Result<Schema, String> {
    state
        .driver()
        .describe_schema(session_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[tracing::instrument(
    name = "cmd.db_database_stats",
    skip(state),
    fields(session = %session_id.0),
)]
pub async fn db_database_stats(
    state: State<'_, DbState>,
    session_id: SessionId,
) -> Result<DatabaseStats, String> {
    state
        .driver()
        .database_stats(session_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[tracing::instrument(
    name = "cmd.db_fetch_blob",
    skip(state, blob_id),
    fields(session = %session_id.0),
)]
pub async fn db_fetch_blob(
    state: State<'_, DbState>,
    session_id: SessionId,
    blob_id: String,
) -> Result<String, String> {
    use std::fmt::Write as _;
    let bytes = state
        .driver()
        .fetch_blob(session_id, blob_id)
        .await
        .map_err(|err| err.to_string())?;
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in &bytes {
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}
