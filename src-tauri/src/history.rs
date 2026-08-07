//! Per-profile SQL query history, in Plamenix's own Firebird database.
//!
//! Lives next to `profiles.json` under the OS-resolved app config
//! directory. Manual / profile-less sessions are intentionally not
//! persisted: history is bound to a profile id so the user sees the
//! right entries when they reopen a saved profile.
//!
//! This used to be SQLite, and the same table existed again in
//! TypeScript in the web server. Both now go through
//! [`plamenix_meta::MetaStore`], which is a Firebird database — the
//! engine this IDE is for, opened embedded, using the driver the app
//! ships. One implementation, and our own driver exercised on every
//! app start.
//!
//! The store is intentionally small. Retention is the `limit` argument
//! to [`HistoryStore::record`]; `clear` is the user's escape hatch.

use std::path::{Path, PathBuf};

use plamenix_meta::{MetaStore, NewHistoryEntry};
use plamenix_types::HistoryEntry;

/// Query history for the desktop shell.
///
/// A thin adapter over the shared store. The methods are `async`
/// because the underlying driver is; the SQLite version was
/// synchronous, which is why the command handlers gained `.await`.
pub struct HistoryStore {
    meta: MetaStore,
}

impl HistoryStore {
    /// Opens — creating on first run — the metadata database.
    ///
    /// # Errors
    ///
    /// A human-readable message when the database cannot be opened,
    /// including the case where another Plamenix instance holds it:
    /// Firebird's embedded engine takes the file exclusively.
    pub async fn open(path: &Path, fbclient_path: Option<String>) -> Result<Self, String> {
        MetaStore::open(path, fbclient_path)
            .await
            .map(|meta| Self { meta })
            .map_err(|err| err.to_string())
    }

    /// The shared store, for anything else that needs it.
    #[must_use]
    pub const fn meta(&self) -> &MetaStore {
        &self.meta
    }

    /// Records one statement, then trims the profile to `limit`.
    ///
    /// # Errors
    ///
    /// A human-readable message when the write fails.
    #[allow(clippy::too_many_arguments)]
    pub async fn record(
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
        self.meta
            .record_history(&NewHistoryEntry {
                profile_id,
                sql,
                executed_at: now,
                duration_ms: i64::try_from(duration_ms).unwrap_or(i64::MAX),
                status,
                error,
                rows_returned: row_count,
                label: None,
            })
            .await
            .map_err(|err| err.to_string())?;

        if let Some(cap) = limit.filter(|n| *n > 0) {
            // Trimming failing is not worth failing the user's query
            // over — the statement already ran, and the only cost is a
            // longer history than they asked for.
            if let Err(err) = self.meta.trim_history(profile_id, cap).await {
                tracing::warn!(%err, profile_id, "could not trim query history");
            }
        }
        Ok(())
    }

    /// Most recent statements for one profile, newest first.
    ///
    /// # Errors
    ///
    /// A human-readable message when the query fails.
    pub async fn list(&self, profile_id: &str, limit: i64) -> Result<Vec<HistoryEntry>, String> {
        self.meta
            .list_history(profile_id, limit)
            .await
            .map_err(|err| err.to_string())
    }

    /// Removes every entry for one profile.
    ///
    /// # Errors
    ///
    /// A human-readable message when the delete fails.
    pub async fn clear(&self, profile_id: &str) -> Result<u64, String> {
        self.meta
            .clear_history(profile_id)
            .await
            .map_err(|err| err.to_string())
    }

    /// Sets or clears one entry's label.
    ///
    /// # Errors
    ///
    /// A human-readable message when the update fails.
    pub async fn set_label(&self, id: i64, label: Option<&str>) -> Result<bool, String> {
        self.meta
            .set_history_label(id, label)
            .await
            .map_err(|err| err.to_string())
    }

    /// Deletes one entry.
    ///
    /// # Errors
    ///
    /// A human-readable message when the delete fails.
    pub async fn delete(&self, id: i64) -> Result<bool, String> {
        self.meta
            .delete_history(id)
            .await
            .map_err(|err| err.to_string())
    }

    /// Deletes several entries.
    ///
    /// # Errors
    ///
    /// A human-readable message when the delete fails.
    pub async fn delete_many(&self, ids: &[i64]) -> Result<u64, String> {
        self.meta
            .delete_history_many(ids)
            .await
            .map_err(|err| err.to_string())
    }
}

fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Where the metadata database lives.
///
/// Named for what it now is rather than for history alone: the same
/// file also holds plugin grants and the audit log.
#[must_use]
pub fn default_history_path(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join("plamenix-meta.fdb")
}
