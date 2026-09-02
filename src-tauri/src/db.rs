//! Tauri-managed wrapper around the shared `plamenix-db` driver.
//!
//! The driver itself is cheap to clone (it shares its session registry
//! through an `Arc`). This wrapper exists so that `tauri::State` can hand
//! out references; clones happen at the call site when commands need an
//! owned driver for an async task.

use plamenix_db::RsfbDriver;

pub struct DbState {
    driver: RsfbDriver,
}

impl DbState {
    pub fn new() -> Self {
        Self {
            driver: RsfbDriver::new(),
        }
    }

    pub const fn driver(&self) -> &RsfbDriver {
        &self.driver
    }
}

impl Default for DbState {
    fn default() -> Self {
        Self::new()
    }
}
