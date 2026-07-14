mod commands;
mod manager;
mod types;

#[cfg(target_os = "macos")]
pub(crate) mod platform_macos;
#[cfg(not(target_os = "macos"))]
pub(crate) mod platform_stub;

#[cfg(target_os = "macos")]
pub(crate) use platform_macos as platform;
#[cfg(not(target_os = "macos"))]
pub(crate) use platform_stub as platform;

pub use commands::*;
pub use manager::WindowVisionManager;

pub fn stop_all() {
    let _ = platform::stop_all();
}
