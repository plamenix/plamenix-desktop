pub mod db;
pub mod export;
pub mod fbclient;
pub mod plugins;
pub mod profiles;

use tauri::AppHandle;

#[tauri::command]
pub fn ping(_app: AppHandle) -> &'static str {
    "pong from plamenix-desktop"
}
