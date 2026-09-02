//! What the desktop shell provides to plugins.
//!
//! `plamenix-plugin-host` implements the ten WIT interfaces but cannot
//! reach anything behind them: the database is a driver this shell
//! constructed, the keyring is an OS facility, the clipboard belongs to
//! a window. It asks through
//! [`plamenix_plugin_host::HostServices`], and this is the desktop's
//! answer.
//!
//! Everything here is a thin adapter. There is no policy in this file —
//! the capability decision was already made in the host's `gate`, and
//! the allow-list for outbound requests in its `check_net`, before any
//! method below is called. Re-deciding here would mean two places that
//! have to agree; forgetting to would make this an open proxy.

use std::collections::HashSet;
use std::sync::Arc;

use plamenix_db::DbDriver;
use plamenix_db::rsfb::RsfbDriver;
use plamenix_plugin_host::{
    CallCtx, HostCell, HostColumn, HostHttpRequest, HostHttpResponse, HostQueryResult, HostRow,
    HostSchema, HostServices, HostStatementOutcome, HostTable, ServiceError,
};
use plamenix_secrets::{SecretRef, SecretStore};
use plamenix_types::SessionId;

use crate::plugins::GrantStore;

/// The desktop edition's implementation.
pub struct DesktopHostServices {
    driver: RsfbDriver,
    grants: Arc<GrantStore>,
    secrets: Arc<dyn SecretStore>,
    http: reqwest::Client,
    app: tauri::AppHandle,
}

impl DesktopHostServices {
    /// Builds the service surface from what the shell already holds.
    pub fn new(
        driver: RsfbDriver,
        grants: Arc<GrantStore>,
        secrets: Arc<dyn SecretStore>,
        app: tauri::AppHandle,
    ) -> Self {
        Self {
            driver,
            grants,
            secrets,
            // Built once. A client per request would discard the
            // connection pool and re-do TLS on every plugin fetch.
            http: reqwest::Client::builder()
                .user_agent(concat!("Plamenix/", env!("CARGO_PKG_VERSION")))
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()
                .unwrap_or_default(),
            app,
        }
    }

    /// The session the host says this call is for.
    ///
    /// Never a value the plugin supplied — the host already refused a
    /// mismatch before calling us, and taking one here would undo that.
    fn session(ctx: &CallCtx) -> Result<SessionId, ServiceError> {
        let raw = ctx.session_id.as_ref().ok_or(ServiceError::NoSession)?;
        raw.parse::<uuid::Uuid>()
            .map(SessionId)
            .map_err(|_| ServiceError::NoSession)
    }
}

fn driver_error(err: &plamenix_db::DbError) -> ServiceError {
    ServiceError::Backend(err.to_string())
}

/// Converts a driver cell without losing what the driver kept.
///
/// `Decimal` stays decimal text. Firebird stores NUMERIC as a scaled
/// integer and this repo vendors a patched `rsfbclient-rust` to stop it
/// being coerced to a double; turning it into an `f64` here would undo
/// that for every plugin that touches money.
fn to_host_cell(cell: plamenix_db::ColumnValue) -> HostCell {
    use plamenix_db::ColumnValue;
    match cell {
        ColumnValue::Null => HostCell::Null,
        ColumnValue::Text(text) => HostCell::Text(text),
        ColumnValue::Integer(value) => HostCell::Integer(value),
        ColumnValue::Decimal(text) => HostCell::Decimal(text),
        ColumnValue::Float(value) => HostCell::Float(value),
        ColumnValue::Bool(value) => HostCell::Bool(value),
        ColumnValue::Blob(blob) => HostCell::Blob {
            id: blob.id,
            size: u64::try_from(blob.size_bytes).unwrap_or_default(),
            peek_hex: blob.peek_hex,
        },
    }
}

fn to_host_result(result: plamenix_db::QueryResult, row_cap: usize) -> HostStatementOutcome {
    match result {
        plamenix_db::QueryResult::Affected { rows } => HostStatementOutcome::Affected(rows),
        plamenix_db::QueryResult::Rows {
            columns,
            rows,
            truncated,
        } => {
            let capped = rows.len() > row_cap;
            HostStatementOutcome::Rows(HostQueryResult {
                columns: columns
                    .into_iter()
                    .map(|column| HostColumn {
                        // The driver carries a name and nothing else.
                        // Reporting `None` rather than inventing a type
                        // keeps a plugin from branching on a guess.
                        name: column.name,
                        sql_type: None,
                        nullable: None,
                    })
                    .collect(),
                rows: rows
                    .into_iter()
                    .take(row_cap)
                    .map(|row| HostRow {
                        cells: row.cells.into_iter().map(to_host_cell).collect(),
                    })
                    .collect(),
                truncated: truncated || capped,
            })
        }
    }
}

#[async_trait::async_trait]
impl HostServices for DesktopHostServices {
    fn granted_for(&self, plugin_id: &str) -> HashSet<String> {
        self.grants.granted_for(plugin_id)
    }

    async fn db_query_read(
        &self,
        ctx: &CallCtx,
        sql: &str,
        row_cap: u32,
    ) -> Result<HostQueryResult, ServiceError> {
        let session = Self::session(ctx)?;
        let result = self
            .driver
            .execute(session, sql.to_owned())
            .await
            .map_err(|err| driver_error(&err))?;

        // A statement that returns no rows is not a read. Reporting it
        // as an empty result would let a plugin holding only read
        // access run an UPDATE and see nothing wrong.
        match to_host_result(result, row_cap as usize) {
            HostStatementOutcome::Rows(rows) => Ok(rows),
            HostStatementOutcome::Affected(_) => Err(ServiceError::Backend(
                "query-read is for statements that return rows; use db-write.execute".to_owned(),
            )),
        }
    }

    async fn db_execute(
        &self,
        ctx: &CallCtx,
        sql: &str,
    ) -> Result<HostStatementOutcome, ServiceError> {
        let session = Self::session(ctx)?;
        let result = self
            .driver
            .execute(session, sql.to_owned())
            .await
            .map_err(|err| driver_error(&err))?;
        Ok(to_host_result(result, usize::MAX))
    }

    async fn db_describe_schema(&self, ctx: &CallCtx) -> Result<HostSchema, ServiceError> {
        let session = Self::session(ctx)?;
        let schema = self
            .driver
            .describe_schema(session)
            .await
            .map_err(|err| driver_error(&err))?;
        Ok(HostSchema {
            tables: schema
                .tables
                .into_iter()
                .map(|table| HostTable {
                    name: table.name,
                    kind: "table".to_owned(),
                })
                .collect(),
        })
    }

    async fn db_tx_begin(&self, ctx: &CallCtx) -> Result<(), ServiceError> {
        let session = Self::session(ctx)?;
        self.driver
            .begin_transaction(session)
            .await
            .map(|_| ())
            .map_err(|err| driver_error(&err))
    }

    async fn db_tx_commit(&self, ctx: &CallCtx) -> Result<(), ServiceError> {
        let session = Self::session(ctx)?;
        self.driver
            .commit(session)
            .await
            .map(|_| ())
            .map_err(|err| driver_error(&err))
    }

    async fn db_tx_rollback(&self, ctx: &CallCtx) -> Result<(), ServiceError> {
        let session = Self::session(ctx)?;
        self.driver
            .rollback(session)
            .await
            .map(|_| ())
            .map_err(|err| driver_error(&err))
    }

    async fn net_fetch(
        &self,
        _ctx: &CallCtx,
        request: HostHttpRequest,
    ) -> Result<HostHttpResponse, ServiceError> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|err| ServiceError::Backend(err.to_string()))?;
        let mut builder = self.http.request(method, &request.url);
        for (name, value) in request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }

        let response = builder
            .send()
            .await
            .map_err(|err| ServiceError::Backend(err.to_string()))?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_owned(),
                    value.to_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();
        let body = response
            .bytes()
            .await
            .map_err(|err| ServiceError::Backend(err.to_string()))?
            .to_vec();

        Ok(HostHttpResponse {
            status,
            headers,
            body,
        })
    }

    async fn clipboard_read(&self, _ctx: &CallCtx) -> Result<Option<String>, ServiceError> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        self.app
            .clipboard()
            .read_text()
            .map(Some)
            .map_err(|err| ServiceError::Backend(err.to_string()))
    }

    async fn clipboard_write(&self, _ctx: &CallCtx, text: &str) -> Result<(), ServiceError> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        self.app
            .clipboard()
            .write_text(text.to_owned())
            .map_err(|err| ServiceError::Backend(err.to_string()))
    }

    async fn notify_display(
        &self,
        _ctx: &CallCtx,
        title: &str,
        body: &str,
    ) -> Result<(), ServiceError> {
        use tauri_plugin_notification::NotificationExt;
        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|err| ServiceError::Backend(err.to_string()))
    }

    async fn keyring_get(
        &self,
        _ctx: &CallCtx,
        service: &str,
        account: &str,
    ) -> Result<Option<String>, ServiceError> {
        let secrets = Arc::clone(&self.secrets);
        let reference = SecretRef::new(service, account);
        // `SecretStore` is synchronous and the first read of an entry
        // can put an OS password prompt in front of the user, so this
        // would otherwise block a tokio worker for as long as they take
        // to answer it.
        blocking(move || match secrets.retrieve(&reference) {
            Ok(secret) => Ok(Some(secret)),
            Err(plamenix_secrets::SecretError::NotFound { .. }) => Ok(None),
            Err(err) => Err(ServiceError::Backend(err.to_string())),
        })
        .await
    }

    async fn keyring_set(
        &self,
        _ctx: &CallCtx,
        service: &str,
        account: &str,
        secret: &str,
    ) -> Result<(), ServiceError> {
        let secrets = Arc::clone(&self.secrets);
        let reference = SecretRef::new(service, account);
        let secret = secret.to_owned();
        blocking(move || {
            secrets
                .store(&reference, &secret)
                .map_err(|err| ServiceError::Backend(err.to_string()))
        })
        .await
    }

    async fn keyring_delete(
        &self,
        _ctx: &CallCtx,
        service: &str,
        account: &str,
    ) -> Result<(), ServiceError> {
        let secrets = Arc::clone(&self.secrets);
        let reference = SecretRef::new(service, account);
        blocking(move || match secrets.delete(&reference) {
            Ok(()) | Err(plamenix_secrets::SecretError::NotFound { .. }) => Ok(()),
            Err(err) => Err(ServiceError::Backend(err.to_string())),
        })
        .await
    }
}

/// Runs a blocking keyring call off the async runtime.
async fn blocking<T, F>(work: F) -> Result<T, ServiceError>
where
    F: FnOnce() -> Result<T, ServiceError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|err| ServiceError::Backend(err.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_decimal_from_the_driver_stays_decimal() {
        // The whole reason this file converts cells by hand. An `f64`
        // here would silently undo the vendored driver patch for every
        // plugin handling money.
        let cell = to_host_cell(plamenix_db::ColumnValue::Decimal(
            "12345678901234567.89".to_owned(),
        ));
        assert_eq!(cell, HostCell::Decimal("12345678901234567.89".to_owned()));
    }

    #[test]
    fn a_read_beyond_the_cap_is_truncated_and_says_so() {
        let rows = (0..50)
            .map(|index| plamenix_db::Row {
                cells: vec![plamenix_db::ColumnValue::Integer(index)],
            })
            .collect();
        let result = plamenix_db::QueryResult::Rows {
            columns: vec![plamenix_db::Column {
                name: "N".to_owned(),
            }],
            rows,
            truncated: false,
        };

        match to_host_result(result, 10) {
            HostStatementOutcome::Rows(rows) => {
                assert_eq!(rows.rows.len(), 10);
                assert!(
                    rows.truncated,
                    "a capped result that did not say so would look complete",
                );
            }
            other => panic!("expected rows, got {other:?}"),
        }
    }
}
