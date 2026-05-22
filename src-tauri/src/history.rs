//! Per-profile SQL query history backed by a single SQLite database.
//!
//! Lives next to `profiles.json` under the OS-resolved app config
//! directory (`history.sqlite`). Manual / profile-less sessions are
//! intentionally not persisted: history is bound to a profile id so
//! the user sees the right entries when they reopen a saved profile.
//!
//! The store is intentionally small. No retention policy yet; the
//! `clear` command is the user's escape hatch.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use plamenix_types::HistoryEntry;
use rusqlite::{Connection, params};

pub struct HistoryStore {
    conn: Mutex<Connection>,
}

impl HistoryStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create history dir: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("open history db: {e}"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS query_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id TEXT NOT NULL,
                sql TEXT NOT NULL,
                executed_at INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL,
                status TEXT NOT NULL,
                error TEXT,
                row_count INTEGER,
                label TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_profile_executed
                ON query_history(profile_id, executed_at DESC);",
        )
        .map_err(|e| format!("migrate history schema: {e}"))?;
        // Pre-H4 databases lack the `label` column; add it lazily.
        // `PRAGMA table_info` is the cheapest portable check; if `label`
        // is absent we run a single `ALTER TABLE` to bring the schema up
        // to date without touching existing rows.
        let has_label = column_exists(&conn, "query_history", "label")?;
        if !has_label {
            conn.execute("ALTER TABLE query_history ADD COLUMN label TEXT", [])
                .map_err(|e| format!("add history.label column: {e}"))?;
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn record(
        &self,
        profile_id: &str,
        sql: &str,
        duration_ms: u64,
        status: &str,
        error: Option<&str>,
        row_count: Option<i64>,
        limit: Option<i64>,
    ) -> Result<(), String> {
        let now = now_epoch_ms();
        let guard = self.conn.lock().map_err(|e| format!("history lock: {e}"))?;
        guard
            .execute(
                "INSERT INTO query_history (profile_id, sql, executed_at, duration_ms, status, error, row_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![profile_id, sql, now, duration_ms as i64, status, error, row_count],
            )
            .map_err(|e| format!("insert history: {e}"))?;
        if let Some(cap) = limit.filter(|n| *n > 0) {
            guard
                .execute(
                    "DELETE FROM query_history
                     WHERE profile_id = ?1
                       AND id NOT IN (
                         SELECT id FROM query_history
                         WHERE profile_id = ?1
                         ORDER BY executed_at DESC, id DESC
                         LIMIT ?2
                       )",
                    params![profile_id, cap],
                )
                .map_err(|e| format!("trim history: {e}"))?;
        }
        Ok(())
    }

    pub fn list(&self, profile_id: &str, limit: i64) -> Result<Vec<HistoryEntry>, String> {
        let guard = self.conn.lock().map_err(|e| format!("history lock: {e}"))?;
        let mut stmt = guard
            .prepare(
                "SELECT id, profile_id, sql, executed_at, duration_ms, status, error, row_count, label
                 FROM query_history
                 WHERE profile_id = ?1
                 ORDER BY executed_at DESC
                 LIMIT ?2",
            )
            .map_err(|e| format!("prepare history list: {e}"))?;
        let rows = stmt
            .query_map(params![profile_id, limit], |row| {
                Ok(HistoryEntry {
                    id: row.get(0)?,
                    profile_id: row.get(1)?,
                    sql: row.get(2)?,
                    executed_at: row.get(3)?,
                    duration_ms: row.get::<_, i64>(4)? as u64,
                    status: row.get(5)?,
                    error: row.get(6)?,
                    row_count: row.get(7)?,
                    label: row.get(8)?,
                })
            })
            .map_err(|e| format!("query history: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("read history row: {e}"))?);
        }
        Ok(out)
    }

    pub fn clear(&self, profile_id: &str) -> Result<u64, String> {
        let guard = self.conn.lock().map_err(|e| format!("history lock: {e}"))?;
        let n = guard
            .execute(
                "DELETE FROM query_history WHERE profile_id = ?1",
                params![profile_id],
            )
            .map_err(|e| format!("delete history: {e}"))?;
        Ok(n as u64)
    }

    /// Sets or clears the free-form label on a single history row. An
    /// empty (or whitespace-only) label clears the field — the host
    /// surfaces this as the "delete the label" affordance. Returns
    /// `true` when a row was updated, `false` when `id` is unknown.
    pub fn set_label(&self, id: i64, label: Option<&str>) -> Result<bool, String> {
        let trimmed = label.map(str::trim).filter(|s| !s.is_empty());
        let guard = self.conn.lock().map_err(|e| format!("history lock: {e}"))?;
        let updated = guard
            .execute(
                "UPDATE query_history SET label = ?1 WHERE id = ?2",
                params![trimmed, id],
            )
            .map_err(|e| format!("update history label: {e}"))?;
        Ok(updated > 0)
    }

    /// Deletes a single history row. Returns `true` when a row was
    /// removed, `false` when `id` is unknown.
    pub fn delete(&self, id: i64) -> Result<bool, String> {
        let guard = self.conn.lock().map_err(|e| format!("history lock: {e}"))?;
        let removed = guard
            .execute("DELETE FROM query_history WHERE id = ?1", params![id])
            .map_err(|e| format!("delete history row: {e}"))?;
        Ok(removed > 0)
    }

    /// Deletes every history row whose id is in `ids`. Returns the
    /// number of rows actually removed. Runs inside a single
    /// transaction so a partial failure does not leave the user with a
    /// half-applied bulk delete.
    pub fn delete_many(&self, ids: &[i64]) -> Result<u64, String> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut guard = self.conn.lock().map_err(|e| format!("history lock: {e}"))?;
        let tx = guard
            .transaction()
            .map_err(|e| format!("begin delete tx: {e}"))?;
        let mut total: u64 = 0;
        {
            let mut stmt = tx
                .prepare("DELETE FROM query_history WHERE id = ?1")
                .map_err(|e| format!("prepare delete: {e}"))?;
            for id in ids {
                let n = stmt
                    .execute(params![id])
                    .map_err(|e| format!("delete row {id}: {e}"))?;
                total += n as u64;
            }
        }
        tx.commit().map_err(|e| format!("commit delete tx: {e}"))?;
        Ok(total)
    }
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare table_info: {e}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| format!("query table_info: {e}"))?;
    while let Some(row) = rows.next().map_err(|e| format!("read table_info row: {e}"))? {
        let name: String = row.get(1).map_err(|e| format!("read column name: {e}"))?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn default_history_path(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join("history.sqlite")
}

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
