use candle_core::{Tensor, Device, Result};
use super::bitnet_brain::CompressedLayer;

#[derive(Clone)]
pub struct BitLinear {
    pub rows: usize,
    pub cols: usize,
    pub scale: f32,
    pub weight_tensor: Tensor,
}

impl BitLinear {
    pub fn new(layer: &CompressedLayer, device: &Device) -> Result<Self> {
        let dequantized = super::ternary_math::dequantize_row_i2_s(&layer.data, layer.scale);
        let weight_tensor = Tensor::from_vec(
            dequantized,
            (layer.rows as usize, layer.cols as usize),
            device,
        )?;
        Ok(Self {
            rows: layer.rows as usize,
            cols: layer.cols as usize,
            scale: layer.scale,
            weight_tensor,
        })
    }

    pub fn forward(&self, x: &Tensor) -> Result<Tensor> {
        let w = self.weight_tensor.t()?;
        let dims = x.dims();
        if dims.len() == 3 {
            let (b_sz, seq_len, hidden_size) = (dims[0], dims[1], dims[2]);
            let x_reshaped = x.reshape((b_sz * seq_len, hidden_size))?;
            let res = x_reshaped.matmul(&w)?;
            res.reshape((b_sz, seq_len, self.rows))
        } else {
            x.matmul(&w)
        }
    }
}


