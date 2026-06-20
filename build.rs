//! build.rs — stamps every compile with a unique build identity so the engine
//! version is never "the same 9.5.0" twice. Injects compile-time env vars that
//! main.rs reads via env!(...):
//!   KAI_BUILD_EPOCH — unix seconds at build time (changes every recompile)
//!   KAI_BUILD_STAMP — human stamp YYYYMMDD.HHMMSS (UTC)
//!   KAI_GIT_HASH    — short git commit (changes whenever code is committed)
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    println!("cargo:rustc-env=KAI_BUILD_EPOCH={}", secs);
    println!("cargo:rustc-env=KAI_BUILD_STAMP={}", utc_stamp(secs));

    let git = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "nogit".to_string());
    println!("cargo:rustc-env=KAI_GIT_HASH={}", git);

    // Re-run on every recompile so the stamp stays fresh (depend on the source dir).
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=build.rs");
}

/// Convert unix seconds to a compact UTC stamp YYYYMMDD.HHMMSS without pulling in
/// a date crate. Proleptic Gregorian, good well past the year 2100.
fn utc_stamp(secs: u64) -> String {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, m, d) = civil_from_days(days as i64);
    format!("{:04}{:02}{:02}.{:02}{:02}{:02}", y, m, d, h, mi, s)
}

/// days since 1970-01-01 -> (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
