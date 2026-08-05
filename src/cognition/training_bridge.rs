use std::sync::{Arc, Mutex};
use std::path::Path;
use crate::cognition::bitnet_brain::BitNetBrain;

pub struct TrainingBridge {
    pub base_model_path: String,
    pub sync_status: String,
    pub last_sync_time: u64,
}

impl TrainingBridge {
    pub fn new(base_model_path: &str) -> Self {
        Self {
            base_model_path: base_model_path.to_string(),
            sync_status: "idle".to_string(),
            last_sync_time: 0,
        }
    }

    /// Triggers a sync with a newly trained Cloud-BitNet LoRA / adapter
    pub fn sync_from_cloud(&mut self, active_brain: &mut BitNetBrain, new_model_path: &str, blend_weight: f32) -> Result<(), &'static str> {
        println!("[TrainingBridge] Starting sync from cloud model at {} with blend weight {}", new_model_path, blend_weight);
        self.sync_status = "syncing".to_string();

        let cloud_model = BitNetBrain::mount(new_model_path).map_err(|e| {
            println!("[TrainingBridge] Failed to mount cloud model: {}", e);
            "Failed to mount cloud model"
        })?;

        active_brain.combine_parameters(&cloud_model, blend_weight)?;

        self.last_sync_time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        self.sync_status = "idle".to_string();
        println!("[TrainingBridge] Sync complete.");

        Ok(())
    }
}
