//! Tauri commands for talking to Firebird via `plamenix-db`.
//!
//! Each command is a thin adapter: parse the inbound argument shape,
//! call into the shared `DbDriver`, and return a serialisable result.
//! No business logic lives here.

use plamenix_db::{ConnectMode, ConnectionConfig, CryptState, DbDriver, QueryResult, SessionId};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbState;

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
pub async fn db_connect(
    state: State<'_, DbState>,
    request: ConnectRequest,
) -> Result<ConnectResponse, String> {
    let mode = if request.pure_rust { ConnectMode::PureRust } else { ConnectMode::Native };
    state
        .driver()
        .connect(request.config, mode)
        .await
        .map(|session_id| ConnectResponse { session_id })
        .map_err(|err| err.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteRequest {
    session_id: SessionId,
    sql: String,
}

#[tauri::command]
pub async fn db_execute(
    state: State<'_, DbState>,
    request: ExecuteRequest,
) -> Result<QueryResult, String> {
    state
        .driver()
        .execute(request.session_id, request.sql)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn db_ping(
    state: State<'_, DbState>,
    session_id: SessionId,
) -> Result<String, String> {
    state.driver().ping(session_id).await.map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn db_close(
    state: State<'_, DbState>,
    session_id: SessionId,
) -> Result<(), String> {
    state.driver().close(session_id).await.map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn db_crypt_state(
    state: State<'_, DbState>,
    session_id: SessionId,
) -> Result<CryptState, String> {
    state.driver().crypt_state(session_id).await.map_err(|err| err.to_string())
}
