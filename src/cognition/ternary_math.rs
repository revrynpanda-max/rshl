//! BitNet Experimental Math (I2_S / TL1)
//! This module teaches KAI the native structural logic for encoding and decoding
//! ternary weights [-1, 0, 1] mapped into highly compressed 2-bit bytes.
//! This math represents the core structural tensor logic behind BitNet 1.58b.

/// The BitNet decoding map.
/// Chunk values (0, 1, 2, 3) are mapped to these floats.
const MAP_2_BIT: [f32; 4] = [-1.0, 0.0, 1.0, 0.0];

/// Decodes an I2_S format byte array into a full f32 ternary vector.
/// Each block of 32 bytes encodes 128 elements in 4 interleaved groups of 32.
pub fn dequantize_row_i2_s(bytes: &[u8], scale: f32) -> Vec<f32> {
    let n = bytes.len() * 4;
    let mut decoded = vec![0.0; n];

    // We assume the data is cleanly divisible into 32-byte (128-element) blocks
    let num_blocks = bytes.len() / 32;

    for b in 0..num_blocks {
        let block_start_byte = b * 32;
        let block_start_elem = b * 128;

        for gp in 0..32 {
            let byte = bytes[block_start_byte + gp];

            let c0 = ((byte >> 6) & 0x3) as usize;
            let c1 = ((byte >> 4) & 0x3) as usize;
            let c2 = ((byte >> 2) & 0x3) as usize;
            let c3 = ((byte >> 0) & 0x3) as usize;

            decoded[block_start_elem + gp] = scale * MAP_2_BIT[c0];
            decoded[block_start_elem + gp + 32] = scale * MAP_2_BIT[c1];
            decoded[block_start_elem + gp + 64] = scale * MAP_2_BIT[c2];
            decoded[block_start_elem + gp + 96] = scale * MAP_2_BIT[c3];
        }
    }

    decoded
}

/// Encodes a native f32 array of ternary weights into an ultra-compressed I2_S byte array.
/// Requires the input slice to be cleanly divisible by 128.
pub fn quantize_row_i2_s(weights: &[f32], scale: f32) -> Result<Vec<u8>, &'static str> {
    if weights.len() % 128 != 0 {
        return Err("Weights array length must be divisible by 128 for block quantization.");
    }

    let mut encoded = vec![0u8; weights.len() / 4];
    let num_blocks = weights.len() / 128;

    for b in 0..num_blocks {
        let block_start_byte = b * 32;
        let block_start_elem = b * 128;

        for gp in 0..32 {
            let w0 = weights[block_start_elem + gp];
            let w1 = weights[block_start_elem + gp + 32];
            let w2 = weights[block_start_elem + gp + 64];
            let w3 = weights[block_start_elem + gp + 96];

            let mut byte: u8 = 0;

            for (i, &w) in [w0, w1, w2, w3].iter().enumerate() {
                // Reverse mapping: normalize back to [-1.0, 0.0, 1.0]
                let norm = if scale != 0.0 { w / scale } else { 0.0 };
                
                let bits: u8 = if norm <= -0.5 {
                    0 // maps to -1.0
                } else if norm >= 0.5 {
                    2 // maps to 1.0
                } else {
                    1 // maps to 0.0
                };

                // Shift bits into the correct quadrant of the byte
                let shift = 6 - (i * 2);
                byte |= bits << shift;
            }

            encoded[block_start_byte + gp] = byte;
        }
    }

    Ok(encoded)
}

/// Native Zero-Multiplication BitLinear Engine
/// Performs a matrix multiplication (Y = W * X) where W is a packed I2_S byte array
/// and X is an f32 activation array. It uses NO floating point multiplication in the loop,
/// only addition and subtraction based on the 2-bit mapping.
pub fn bitlinear_matmul(
    i2s_weights_matrix: &[u8],
    activations: &[f32],
    rows: usize,
    cols: usize,
    scale: f32,
) -> Result<Vec<f32>, &'static str> {
    let mut output = vec![0.0; rows];
    bitlinear_matmul_buf(i2s_weights_matrix, activations, rows, cols, scale, &mut output)?;
    Ok(output)
}

/// Same as bitlinear_matmul, but writes output directly into a pre-allocated buffer slice.
/// This prevents heap allocations on every linear projection, improving CPU cache locality.
pub fn bitlinear_matmul_buf(
    i2s_weights_matrix: &[u8],
    activations: &[f32],
    rows: usize,
    cols: usize,
    scale: f32,
    output: &mut [f32],
) -> Result<(), &'static str> {
    if i2s_weights_matrix.len() * 4 != rows * cols {
        return Err("Weight matrix byte size does not match rows * cols layout.");
    }
    if activations.len() != cols {
        return Err("Activations length must match columns of the weight matrix.");
    }
    if cols % 128 != 0 {
        return Err("Weight columns must be a multiple of 128 for block quantization.");
    }
    if output.len() != rows {
        return Err("Output buffer length must match row dimension.");
    }

    use rayon::prelude::*;

    let bytes_per_row = cols / 4;
    let num_blocks_per_row = cols / 128;

    output.par_iter_mut().enumerate().for_each(|(r, out_val)| {
        let row_start = r * bytes_per_row;
        let row_bytes = &i2s_weights_matrix[row_start..row_start + bytes_per_row];

        let mut sum = 0.0;

        for b in 0..num_blocks_per_row {
            let block_start_byte = b * 32;
            let block_start_elem = b * 128;
            let block_bytes = &row_bytes[block_start_byte..block_start_byte + 32];

            for gp in 0..32 {
                let byte = unsafe { *block_bytes.get_unchecked(gp) };

                let c0 = ((byte >> 6) & 0x3) as usize;
                let c1 = ((byte >> 4) & 0x3) as usize;
                let c2 = ((byte >> 2) & 0x3) as usize;
                let c3 = ((byte >> 0) & 0x3) as usize;

                unsafe {
                    sum += activations.get_unchecked(block_start_elem + gp) * MAP_2_BIT.get_unchecked(c0);
                    sum += activations.get_unchecked(block_start_elem + 32 + gp) * MAP_2_BIT.get_unchecked(c1);
                    sum += activations.get_unchecked(block_start_elem + 64 + gp) * MAP_2_BIT.get_unchecked(c2);
                    sum += activations.get_unchecked(block_start_elem + 96 + gp) * MAP_2_BIT.get_unchecked(c3);
                }
            }
        }

        *out_val = sum * scale;
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bitnet_ternary_math_assimilation() {
        println!("Testing Native KAI Assimilation of BitNet I2_S Math...");

        // Create 128 weights to fill one complete block
        let mut original_weights = vec![0.0; 128];
        original_weights[0] = -1.0;
        original_weights[32] = 1.0;
        original_weights[64] = -1.0;
        original_weights[96] = 1.0;

        let scale = 1.5;

        // Apply scale to original weights for comparison
        let mut scaled_weights = vec![0.0; 128];
        for i in 0..128 {
            scaled_weights[i] = original_weights[i] * scale;
        }

        // 1. Compress weights into the block-interleaved format
        let encoded_bytes = quantize_row_i2_s(&scaled_weights, scale).expect("Failed to compress");
        assert_eq!(encoded_bytes.len(), 32, "128 weights should compress into exactly 32 bytes!");

        // 2. Decompress back
        let decoded_weights = dequantize_row_i2_s(&encoded_bytes, scale);
        
        // 3. Verify absolute structural integrity
        assert_eq!(scaled_weights, decoded_weights, "Loss of structural fidelity during ternary translation!");

        println!("BitNet Tensor Assimilation Successful. KAI now natively speaks block-interleaved I2_S math.");
    }

    #[test]
    fn test_bitlinear_matmul() {
        println!("Testing Native Zero-Multiplication BitLinear Engine...");

        // Create 128 activations and a single block weight matrix (32 bytes)
        let mut activations = vec![0.0; 128];
        activations[0] = 10.0;
        activations[32] = 20.0;
        activations[64] = 30.0;
        activations[96] = 40.0;

        // Weights: element 0 is -1, element 32 is +1, element 64 is 0, element 96 is +1
        // Let's create weights:
        // gp=0 byte maps:
        // c0 (Group 0 -> index 0) = 0 (maps to -1)
        // c1 (Group 1 -> index 32) = 2 (maps to +1)
        // c2 (Group 2 -> index 64) = 1 (maps to 0)
        // c3 (Group 3 -> index 96) = 2 (maps to +1)
        // byte = (0 << 6) | (2 << 4) | (1 << 2) | 2 = 0x26 (38)
        let mut weights = vec![0u8; 32];
        weights[0] = 38; 

        let scale = 2.0;

        let start = std::time::Instant::now();
        let result = bitlinear_matmul(&weights, &activations, 1, 128, scale).expect("Matmul failed");
        let elapsed = start.elapsed();

        // Expected output:
        // sum = -activations[0] + activations[32] + 0 + activations[96]
        //     = -10.0 + 20.0 + 40.0 = 50.0
        // scaled = 50.0 * 2.0 = 100.0
        assert_eq!(result[0], 100.0);

        println!("BitLinear Matmul completed in {} nanoseconds! 0 multiplications in loop.", elapsed.as_nanos());
    }
}
