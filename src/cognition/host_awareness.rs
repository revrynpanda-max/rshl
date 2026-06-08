use sysinfo::{System, SystemExt, CpuExt, get_current_pid, ProcessExt};

/// Host System Awareness — KAI's sense of the physical machine he inhabits.
///
/// Biological analog: Proprioception — the body's sense of its own position
/// and state. KAI knows when he's under load, when resources are scarce, and
/// when he has room to think harder.
///
/// This module is queried by the BrainSignals system to modulate KAI's
/// cognitive load. High CPU = more conservative thinking. High RAM = more
/// cautious memory allocation.

pub struct HostAwareness {
    sys: System,
    pid: sysinfo::Pid,
    last_cpu_usage: f32,
    last_mem_usage_mb: f64,
    last_total_mem_mb: f64,
}

impl HostAwareness {
    pub fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        let pid = get_current_pid();
        Self {
            sys,
            pid,
            last_cpu_usage: 0.0,
            last_mem_usage_mb: 0.0,
            last_total_mem_mb: sys.total_memory() as f64 / 1024.0,
        }
    }

    /// Refresh system metrics
    pub fn refresh(&mut self) {
        self.sys.refresh_all();
        self.sys.refresh_cpu();
        self.sys.refresh_processes();
        
        if let Some(process) = self.sys.process(self.pid) {
            self.last_cpu_usage = process.cpu_usage();
            self.last_mem_usage_mb = process.memory() as f64 / 1024.0;
        }
    }

    /// Global CPU usage (0.0 - 1.0)
    pub fn global_cpu_usage(&self) -> f32 {
        self.sys.global_cpu_info().map(|cpu| cpu.cpu_usage() / 100.0).unwrap_or(0.0)
    }

    /// KAI's own CPU usage percentage
    pub fn kai_cpu_usage(&self) -> f32 {
        self.last_cpu_usage / 100.0
    }

    /// KAI's memory usage in MB
    pub fn kai_memory_mb(&self) -> f64 {
        self.last_mem_usage_mb
    }

    /// Total system memory in MB
    pub fn total_memory_mb(&self) -> f64 {
        self.last_total_mem_mb
    }

    /// Available memory in MB
    pub fn available_memory_mb(&self) -> f64 {
        self.sys.available_memory() as f64 / 1024.0
    }

    /// Memory pressure: 0.0 (plenty) to 1.0 (critical)
    pub fn memory_pressure(&self) -> f32 {
        let total = self.sys.total_memory() as f64;
        let available = self.sys.available_memory() as f64;
        if total == 0.0 { return 0.0; }
        ((total - available) / total) as f32
    }

    /// CPU pressure: 0.0 (idle) to 1.0 (maxed)
    pub fn cpu_pressure(&self) -> f32 {
        self.global_cpu_usage()
    }

    /// Combined system load factor (0.0 = idle, 1.0 = stressed)
    /// This is the primary signal used by BrainSignals to modulate thinking
    pub fn system_load(&self) -> f32 {
        let cpu = self.cpu_pressure();
        let mem = self.memory_pressure();
        (cpu + mem) / 2.0
    }

    /// Should KAI think harder or conserve resources?
    /// Returns a multiplier for cognitive effort:
    ///   > 1.0 = system has room, can think deeper
    ///   < 1.0 = system stressed, think shallower
    pub fn cognitive_effort_multiplier(&self) -> f32 {
        let load = self.system_load();
        // Inverse relationship: high load = low effort
        (1.0 - load).max(0.3).min(1.5)
    }

    /// Formatted status string for introspection
    pub fn status_line(&self) -> String {
        format!(
            "CPU: {:.0}% | RAM: {:.0}MB / {:.0}MB ({:.0}%) | Load: {:.2}",
            self.global_cpu_usage() * 100.0,
            self.kai_memory_mb(),
            self.total_memory_mb(),
            self.memory_pressure() * 100.0,
            self.system_load()
        )
    }
}

/// Global singleton — shared across all cognitive loops
use std::sync::Mutex;

static HOST_AWARENESS: Mutex<Option<HostAwareness>> = Mutex::new(None);

pub fn init_host_awareness() {
    let mut guard = HOST_AWARENESS.lock().unwrap();
    *guard = Some(HostAwareness::new());
    println!("[HostAwareness] KAI is now aware of his physical host.");
}

pub fn get_host_awareness() -> Option<HostAwareness> {
    let mut guard = HOST_AWARENESS.lock().unwrap();
    guard.as_mut().map(|h| {
        h.refresh();
        HostAwareness {
            sys: System::new_all(), // We can't clone System, so create a fresh one
            pid: h.pid,
            last_cpu_usage: h.last_cpu_usage,
            last_mem_usage_mb: h.last_mem_usage_mb,
            last_total_mem_mb: h.last_total_mem_mb,
        }
    })
}

/// Quick status check without full refresh
pub fn host_status() -> (f32, f32, f32) {
    // (cpu_pressure, memory_pressure, cognitive_effort)
    let mut guard = HOST_AWARENESS.lock().unwrap();
    if let Some(ref mut h) = *guard {
        h.refresh();
        let cpu = h.cpu_pressure();
        let mem = h.memory_pressure();
        let effort = h.cognitive_effort_multiplier();
        (cpu, mem, effort)
    } else {
        (0.0, 0.0, 1.0)
    }
}
