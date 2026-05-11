pub mod db;
pub mod profiles;

use tauri::AppHandle;

#[tauri::command]
pub fn ping(_app: AppHandle) -> &'static str {
    "pong from plamenix-desktop"
}
