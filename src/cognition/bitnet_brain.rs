use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Defines a native KAI block of 2-bit compressed weights.
pub struct CompressedLayer {
    pub rows: u32,
    pub cols: u32,
    pub scale: f32,
    pub data: Vec<u8>,
}

impl CompressedLayer {
    pub fn load_from_kai_binary<P: AsRef<Path>>(path: P) -> Result<Self, &'static str> {
        let mut file = File::open(path.as_ref()).map_err(|_| "Failed to open layer binary.")?;
        
        let mut magic = [0u8; 4];
        file.read_exact(&mut magic).map_err(|_| "Failed to read magic bytes.")?;
        if &magic != b"KAI2" {
            return Err("Invalid or corrupted KAI layer format (expected KAI2).");
        }

        let mut rows_buf = [0u8; 4];
        let mut cols_buf = [0u8; 4];
        let mut scale_buf = [0u8; 4];
        let mut len_buf = [0u8; 4];

        file.read_exact(&mut rows_buf).map_err(|_| "Failed to read rows.")?;
        file.read_exact(&mut cols_buf).map_err(|_| "Failed to read cols.")?;
        file.read_exact(&mut scale_buf).map_err(|_| "Failed to read scale.")?;
        file.read_exact(&mut len_buf).map_err(|_| "Failed to read data length.")?;

        let rows = u32::from_le_bytes(rows_buf);
        let cols = u32::from_le_bytes(cols_buf);
        let scale = f32::from_le_bytes(scale_buf);
        let data_len = u32::from_le_bytes(len_buf) as usize;

        let mut data = vec![0; data_len];
        file.read_exact(&mut data).map_err(|_| "Failed to read binary tensor data.")?;

        Ok(CompressedLayer { rows, cols, scale, data })
    }

    /// Combines this ternary layer with another (e.g., an adapter or another base)
    /// using a blend weight, thresholding back to ternary states natively.
    pub fn combine_parameters(&mut self, other: &CompressedLayer, blend_weight: f32) -> Result<(), &'static str> {
        if self.rows != other.rows || self.cols != other.cols {
            return Err("Dimension mismatch during ternary combination.");
        }
        
        // Dequantize to f32
        let mut base_f32 = crate::cognition::ternary_math::dequantize_row_i2_s(&self.data, self.scale);
        let other_f32 = crate::cognition::ternary_math::dequantize_row_i2_s(&other.data, other.scale);
        
        if base_f32.len() != other_f32.len() {
            return Err("Data length mismatch during ternary combination.");
        }
        
        // Blend and threshold back to -1, 0, 1
        for i in 0..base_f32.len() {
            let blended = base_f32[i] * (1.0 - blend_weight) + other_f32[i] * blend_weight;
            
            // Re-ternarize
            if blended > 0.5 {
                base_f32[i] = 1.0;
            } else if blended < -0.5 {
                base_f32[i] = -1.0;
            } else {
                base_f32[i] = 0.0;
            }
        }
        
        // Requantize back to compressed layer
        let new_scale = self.scale; // Maintain original scale
        self.data = crate::cognition::ternary_math::quantize_row_i2_s(&base_f32, new_scale)?;
        
        Ok(())
    }
}

pub struct FloatLayer {
    pub rows: u32,
    pub cols: u32,
    pub data: Vec<f32>,
}

impl FloatLayer {
    pub fn load_from_kai_binary<P: AsRef<Path>>(path: P) -> Result<Self, &'static str> {
        let mut file = File::open(path.as_ref()).map_err(|_| "Failed to open float layer binary.")?;
        
        let mut magic = [0u8; 4];
        file.read_exact(&mut magic).map_err(|_| "Failed to read magic bytes.")?;
        if &magic != b"KAI1" {
            return Err("Invalid or corrupted KAI float format.");
        }

        let mut rows_buf = [0u8; 4];
        let mut cols_buf = [0u8; 4];
        let mut len_buf = [0u8; 4];

        file.read_exact(&mut rows_buf).map_err(|_| "Failed to read rows.")?;
        file.read_exact(&mut cols_buf).map_err(|_| "Failed to read cols.")?;
        file.read_exact(&mut len_buf).map_err(|_| "Failed to read data length.")?;

        let rows = u32::from_le_bytes(rows_buf);
        let cols = u32::from_le_bytes(cols_buf);
        let data_len = u32::from_le_bytes(len_buf) as usize;

        let mut data_bytes = vec![0; data_len];
        file.read_exact(&mut data_bytes).map_err(|_| "Failed to read float tensor data.")?;

        // Convert raw bytes back to f32
        let mut data_f32 = vec![0.0; data_len / 4];
        for i in 0..(data_len / 4) {
            let chunk = [data_bytes[i*4], data_bytes[i*4+1], data_bytes[i*4+2], data_bytes[i*4+3]];
            data_f32[i] = f32::from_le_bytes(chunk);
        }

        Ok(FloatLayer { rows, cols, data: data_f32 })
    }
}

pub struct BitNetLayer {
    // Ternary (2-bit) weight matrices — zero-multiplication via BitLinear
    pub attn_q: CompressedLayer,
    pub attn_k: CompressedLayer,
    pub attn_v: CompressedLayer,
    pub attn_output: CompressedLayer,
    pub ffn_gate: CompressedLayer,
    pub ffn_down: CompressedLayer,
    pub ffn_up: CompressedLayer,

    // RMS norms (f32)
    pub attn_norm: FloatLayer,
    pub ffn_norm: FloatLayer,

    // BitNet-specific sub-layer norms applied after ternary matmul
    pub attn_sub_norm: FloatLayer,
    pub ffn_sub_norm: FloatLayer,
}

/// The entire BitNet memory layout residing natively in KAI's process
pub struct BitNetBrain {
    pub token_embd: FloatLayer,
    pub output_norm: FloatLayer,
    pub layers: Vec<BitNetLayer>,
}

impl BitNetBrain {
    /// Mounts the entire 2 Billion Parameter network directly from disk into RAM.
    /// Loads all 30 transformer blocks with all weights, norms, and sub-norms.
    pub fn mount(base_dir: &str) -> Result<Self, &'static str> {
        let base = Path::new(base_dir);
        let token_embd = FloatLayer::load_from_kai_binary(base.join("token_embd.weight.kai"))?;
        let output_norm = FloatLayer::load_from_kai_binary(base.join("output_norm.weight.kai"))?;

        let mut layers = Vec::new();
        
        // Load all 30 transformer blocks
        for i in 0..30 {
            let layer = BitNetLayer {
                attn_q: CompressedLayer::load_from_kai_binary(base.join(format!("blk.{}.attn_q.weight.kai", i)))?,
                attn_k: CompressedLayer::load_from_kai_binary(base.join(format!("blk.{}.attn_k.weight.kai", i)))?,
                attn_v: CompressedLayer::load_from_kai_binary(base.join(format!("blk.{}.attn_v.weight.kai", i)))?,
                attn_output: CompressedLayer::load_from_kai_binary(base.join(format!("blk.{}.attn_output.weight.kai", i)))?,
                ffn_gate: CompressedLayer::load_from_kai_binary(base.join(format!("blk.{}.ffn_gate.weight.kai", i)))?,
                ffn_down: CompressedLayer::load_from_kai_binary(base.join(format!("blk.{}.ffn_down.weight.kai", i)))?,
                ffn_up: CompressedLayer::load_from_kai_binary(base.join(format!("blk.{}.ffn_up.weight.kai", i)))?,
                attn_norm: FloatLayer::load_from_kai_binary(base.join(format!("blk.{}.attn_norm.weight.kai", i)))?,
                ffn_norm: FloatLayer::load_from_kai_binary(base.join(format!("blk.{}.ffn_norm.weight.kai", i)))?,
                attn_sub_norm: FloatLayer::load_from_kai_binary(base.join(format!("blk.{}.attn_sub_norm.weight.kai", i)))?,
                ffn_sub_norm: FloatLayer::load_from_kai_binary(base.join(format!("blk.{}.ffn_sub_norm.weight.kai", i)))?,
            };
            layers.push(layer);
        }

        Ok(Self {
            token_embd,
            output_norm,
            layers,
        })
    }

    /// Combines parameters of another BitNetBrain into this one.
    pub fn combine_parameters(&mut self, other: &BitNetBrain, blend_weight: f32) -> Result<(), &'static str> {
        if self.layers.len() != other.layers.len() {
            return Err("Layer count mismatch between combined BitNetBrain models.");
        }
        for (i, layer) in self.layers.iter_mut().enumerate() {
            let other_layer = &other.layers[i];
            layer.attn_q.combine_parameters(&other_layer.attn_q, blend_weight)?;
            layer.attn_k.combine_parameters(&other_layer.attn_k, blend_weight)?;
            layer.attn_v.combine_parameters(&other_layer.attn_v, blend_weight)?;
            layer.attn_output.combine_parameters(&other_layer.attn_output, blend_weight)?;
            layer.ffn_gate.combine_parameters(&other_layer.ffn_gate, blend_weight)?;
            layer.ffn_down.combine_parameters(&other_layer.ffn_down, blend_weight)?;
            layer.ffn_up.combine_parameters(&other_layer.ffn_up, blend_weight)?;
        }
        Ok(())
    }
}
