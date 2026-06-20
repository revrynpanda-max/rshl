//! BitNet b1.58 2B-4T Transformer Implementation
//!
//! Native inference engine for the BitNet architecture using ternary {-1, 0, +1} weights.
//! Based on the Llama architecture with BitNet-specific sub-layer norms applied after
//! each ternary matmul operation (attn_sub_norm and ffn_sub_norm).
//!
//! Architecture (from GGUF metadata):
//!   hidden_size: 2560, intermediate_size: 6912, num_hidden_layers: 30,
//!   num_attention_heads: 20, num_key_value_heads: 5, head_dim: 128,
//!   vocab_size: 128256, rope_theta: 500000.0, rms_norm_eps: 1e-5

use candle_core::{DType, Device, IndexOp, Result, Tensor, D};
use candle_nn::{Embedding, Module, RmsNorm, Linear};
use std::collections::HashMap;
use super::bitnet_inference::BitLinear;

pub const DEFAULT_MAX_SEQ_LEN: usize = 4096;

#[derive(Debug, Clone)]
pub struct Config {
    pub hidden_size: usize,
    pub intermediate_size: usize,
    pub vocab_size: usize,
    pub num_hidden_layers: usize,
    pub num_attention_heads: usize,
    pub num_key_value_heads: usize,
    pub head_dim: usize,
    pub rms_norm_eps: f64,
    pub rope_theta: f32,
    pub max_position_embeddings: usize,
    pub bos_token_id: u32,
    pub eos_token_id: u32,
}

impl Config {
    /// Configuration for BitNet b1.58 2B-4T as extracted from the GGUF metadata.
    pub fn bitnet_2b_4t() -> Self {
        Self {
            hidden_size: 2560,
            intermediate_size: 6912,
            vocab_size: 128256,
            num_hidden_layers: 30,
            num_attention_heads: 20,
            num_key_value_heads: 5,
            head_dim: 128,  // rope.dimension_count from GGUF
            rms_norm_eps: 1e-5,
            rope_theta: 500000.0,
            max_position_embeddings: DEFAULT_MAX_SEQ_LEN,
            bos_token_id: 128000,
            eos_token_id: 128001,
        }
    }
}

// ─── Cache (KV cache + RoPE precomputation) ──────────────────────────────────

#[derive(Debug, Clone)]
pub struct Cache {
    masks: HashMap<(usize, usize), Tensor>,
    pub use_kv_cache: bool,
    kvs: Vec<Option<(Tensor, Tensor)>>,
    cos: Tensor,
    sin: Tensor,
    device: Device,
}

impl Cache {
    pub fn new(use_kv_cache: bool, dtype: DType, config: &Config, device: &Device) -> Result<Self> {
        // Precompute RoPE frequencies
        let inv_freq: Vec<f32> = (0..config.head_dim)
            .step_by(2)
            .map(|i| 1f32 / config.rope_theta.powf(i as f32 / config.head_dim as f32))
            .collect();

        let theta = Tensor::new(inv_freq, device)?;
        let idx_theta = Tensor::arange(0, config.max_position_embeddings as u32, device)?
            .to_dtype(DType::F32)?
            .reshape((config.max_position_embeddings, 1))?
            .matmul(&theta.reshape((1, theta.elem_count()))?)?;

        let cos = idx_theta.cos()?.to_dtype(dtype)?;
        let sin = idx_theta.sin()?.to_dtype(dtype)?;

        Ok(Self {
            masks: HashMap::new(),
            use_kv_cache,
            kvs: vec![None; config.num_hidden_layers],
            device: device.clone(),
            cos,
            sin,
        })
    }

    fn mask(&mut self, seq_len: usize, index_pos: usize) -> Result<Tensor> {
        let kv_len = index_pos + seq_len;
        if let Some(mask) = self.masks.get(&(seq_len, kv_len)) {
            Ok(mask.clone())
        } else {
            let mask = build_causal_mask(seq_len, index_pos, &self.device)?;
            self.masks.insert((seq_len, kv_len), mask.clone());
            Ok(mask)
        }
    }
}

fn build_causal_mask(seq_len: usize, index_pos: usize, device: &Device) -> Result<Tensor> {
    let mask: Vec<_> = (0..seq_len)
        .flat_map(|i| {
            (0..seq_len).map(move |j| {
                if j > i { f32::NEG_INFINITY } else { 0f32 }
            })
        })
        .collect();
    let mask = Tensor::from_slice(&mask, (seq_len, seq_len), device)?;
    let mask = mask.pad_with_zeros(1, index_pos, 0)?;
    Ok(mask)
}

fn repeat_kv(x: Tensor, num_groups: usize) -> Result<Tensor> {
    if num_groups == 1 {
        return Ok(x);
    }
    let (b_sz, n_kv_heads, seq_len, head_dim) = x.dims4()?;
    let x = x
        .unsqueeze(2)?
        .expand((b_sz, n_kv_heads, num_groups, seq_len, head_dim))?
        .reshape((b_sz, n_kv_heads * num_groups, seq_len, head_dim))?;
    Ok(x)
}

fn masked_fill(on_false: &Tensor, mask: &Tensor, on_true: f32) -> Result<Tensor> {
    let shape = mask.shape();
    let on_true = Tensor::new(on_true, on_false.device())?.broadcast_as(shape.dims())?;
    let m = mask.where_cond(&on_true, on_false)?;
    Ok(m)
}

// ─── BitNet Self-Attention ───────────────────────────────────────────────────

#[derive(Clone)]
struct CausalSelfAttention {
    q_proj: BitLinear,
    k_proj: BitLinear,
    v_proj: BitLinear,
    o_proj: BitLinear,
    /// BitNet-specific: RMS norm applied after the attention output ternary matmul
    attn_sub_norm: RmsNorm,
    num_attention_heads: usize,
    num_key_value_heads: usize,
    head_dim: usize,
    max_position_embeddings: usize,
}

impl CausalSelfAttention {
    fn apply_rotary_emb(&self, x: &Tensor, index_pos: usize, cache: &Cache) -> Result<Tensor> {
        let (_b_sz, _, seq_len, _hidden_size) = x.dims4()?;
        let cos = cache.cos.narrow(0, index_pos, seq_len)?;
        let sin = cache.sin.narrow(0, index_pos, seq_len)?;
        candle_nn::rotary_emb::rope(x, &cos, &sin)
    }

    fn forward(
        &self,
        x: &Tensor,
        index_pos: usize,
        block_idx: usize,
        cache: &mut Cache,
    ) -> Result<Tensor> {
        let (b_sz, seq_len, hidden_size) = x.dims3()?;
        let q = self.q_proj.forward(x)?;
        let k = self.k_proj.forward(x)?;
        let v = self.v_proj.forward(x)?;

        let q = q
            .reshape((b_sz, seq_len, self.num_attention_heads, self.head_dim))?
            .transpose(1, 2)?
            .contiguous()?;
        let k = k
            .reshape((b_sz, seq_len, self.num_key_value_heads, self.head_dim))?
            .transpose(1, 2)?
            .contiguous()?;
        let mut v = v
            .reshape((b_sz, seq_len, self.num_key_value_heads, self.head_dim))?
            .transpose(1, 2)?;

        let q = self.apply_rotary_emb(&q, index_pos, cache)?;
        let mut k = self.apply_rotary_emb(&k, index_pos, cache)?;

        // KV cache
        if cache.use_kv_cache {
            if let Some((cache_k, cache_v)) = &cache.kvs[block_idx] {
                k = Tensor::cat(&[cache_k, &k], 2)?.contiguous()?;
                v = Tensor::cat(&[cache_v, &v], 2)?.contiguous()?;
            }
            cache.kvs[block_idx] = Some((k.clone(), v.clone()));
        }

        // GQA expansion
        let n_rep = self.num_attention_heads / self.num_key_value_heads;
        let k = repeat_kv(k, n_rep)?;
        let v = repeat_kv(v, n_rep)?;

        // Scaled dot-product attention
        let in_dtype = q.dtype();
        let q = q.to_dtype(DType::F32)?;
        let k = k.to_dtype(DType::F32)?;
        let v = v.to_dtype(DType::F32)?;
        let att = (q.matmul(&k.t()?)? / (self.head_dim as f64).sqrt())?;
        let att = if seq_len == 1 {
            att
        } else {
            let mask = cache.mask(seq_len, index_pos)?.broadcast_as(att.shape())?;
            (att + mask)?
        };
        let att = candle_nn::ops::softmax_last_dim(&att)?;
        let y = att.matmul(&v.contiguous()?)?.to_dtype(in_dtype)?;

        // Reshape back: (b, heads, seq, head_dim) -> (b, seq, hidden)
        let y = y.transpose(1, 2)?.reshape((b_sz, seq_len, hidden_size))?;

        // BitNet sub-norm: normalize before the output ternary projection
        let y = self.attn_sub_norm.forward(&y)?;
        let y = self.o_proj.forward(&y)?;
        Ok(y)
    }
}

// ─── BitNet MLP ──────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Mlp {
    gate_proj: BitLinear,
    up_proj: BitLinear,
    down_proj: BitLinear,
    /// BitNet-specific: RMS norm applied to the intermediate (6912-dim) before down_proj
    ffn_sub_norm: RmsNorm,
}

impl Mlp {
    fn forward(&self, x: &Tensor) -> Result<Tensor> {
        let gate = candle_nn::ops::silu(&self.gate_proj.forward(x)?)?;
        let up = self.up_proj.forward(x)?;
        let x = (gate * up)?;
        // BitNet sub-norm: normalize intermediate representation before the down projection
        let x = self.ffn_sub_norm.forward(&x)?;
        let x = self.down_proj.forward(&x)?;
        Ok(x)
    }
}

// ─── Transformer Block ──────────────────────────────────────────────────────

#[derive(Clone)]
struct Block {
    rms_1: RmsNorm,    // input_layernorm (attn_norm)
    attn: CausalSelfAttention,
    rms_2: RmsNorm,    // post_attention_layernorm (ffn_norm)
    mlp: Mlp,
}

impl Block {
    fn forward(
        &self,
        x: &Tensor,
        index_pos: usize,
        block_idx: usize,
        cache: &mut Cache,
    ) -> Result<Tensor> {
        let residual = x;
        let x = self.rms_1.forward(x)?;
        let x = (self.attn.forward(&x, index_pos, block_idx, cache)? + residual)?;
        let residual = &x;
        let x = (self.mlp.forward(&self.rms_2.forward(&x)?)? + residual)?;
        Ok(x)
    }
}

// ─── Full BitNet Model ──────────────────────────────────────────────────────

#[derive(Clone)]
pub struct Llama {
    wte: Embedding,
    blocks: Vec<Block>,
    ln_f: RmsNorm,
    lm_head: Linear,
}

impl Llama {
    pub fn forward(&self, x: &Tensor, index_pos: usize, cache: &mut Cache) -> Result<Tensor> {
        let (_b_sz, seq_len) = x.dims2()?;
        let mut x = self.wte.forward(x)?;
        for (block_idx, block) in self.blocks.iter().enumerate() {
            x = block.forward(&x, index_pos, block_idx, cache)?;
        }
        let x = self.ln_f.forward(&x)?;
        let x = x.i((.., seq_len - 1, ..))?;
        let logits = self.lm_head.forward(&x)?;
        logits.to_dtype(DType::F32)
    }

    /// Build the full transformer from the BitNetBrain memory layout.
    /// Maps all 30 layers, including BitNet-specific sub-norms.
    pub fn from_brain(
        brain: &crate::cognition::bitnet_brain::BitNetBrain,
        config: &Config,
        device: &Device,
    ) -> Result<Self> {
        // Token embedding: (vocab_size, hidden_size) float matrix
        let wte = Embedding::new(
            Tensor::from_vec(
                brain.token_embd.data.clone(),
                (brain.token_embd.rows as usize, brain.token_embd.cols as usize),
                device,
            )?,
            brain.token_embd.cols as usize,
        );

        // LM head: tied weights (same as token embedding, transposed for projection)
        let lm_head = Linear::new(
            Tensor::from_vec(
                brain.token_embd.data.clone(),
                (brain.token_embd.rows as usize, brain.token_embd.cols as usize),
                device,
            )?,
            None,
        );

        // Final output norm
        let ln_f = RmsNorm::new(
            Tensor::from_vec(
                brain.output_norm.data.clone(),
                (brain.output_norm.cols as usize,),
                device,
            )?,
            config.rms_norm_eps,
        );

        // Build all 30 transformer blocks
        let mut blocks = Vec::with_capacity(config.num_hidden_layers);
        for layer in &brain.layers {
            // Attention sub-norm (BitNet-specific: applied after o_proj ternary matmul)
            let attn_sub_norm = RmsNorm::new(
                Tensor::from_vec(
                    layer.attn_sub_norm.data.clone(),
                    (layer.attn_sub_norm.cols as usize,),
                    device,
                )?,
                config.rms_norm_eps,
            );

            let attn = CausalSelfAttention {
                q_proj: BitLinear::new(&layer.attn_q, device)?,
                k_proj: BitLinear::new(&layer.attn_k, device)?,
                v_proj: BitLinear::new(&layer.attn_v, device)?,
                o_proj: BitLinear::new(&layer.attn_output, device)?,
                attn_sub_norm,
                num_attention_heads: config.num_attention_heads,
                num_key_value_heads: config.num_key_value_heads,
                head_dim: config.head_dim,
                max_position_embeddings: config.max_position_embeddings,
            };

            // FFN sub-norm (BitNet-specific: applied after down_proj ternary matmul)
            let ffn_sub_norm = RmsNorm::new(
                Tensor::from_vec(
                    layer.ffn_sub_norm.data.clone(),
                    (layer.ffn_sub_norm.cols as usize,),
                    device,
                )?,
                config.rms_norm_eps,
            );

            let mlp = Mlp {
                gate_proj: BitLinear::new(&layer.ffn_gate, device)?,
                up_proj: BitLinear::new(&layer.ffn_up, device)?,
                down_proj: BitLinear::new(&layer.ffn_down, device)?,
                ffn_sub_norm,
            };


            // Pre-attention RMS norm
            let rms_1 = RmsNorm::new(
                Tensor::from_vec(
                    layer.attn_norm.data.clone(),
                    (layer.attn_norm.cols as usize,),
                    device,
                )?,
                config.rms_norm_eps,
            );

            // Pre-FFN RMS norm
            let rms_2 = RmsNorm::new(
                Tensor::from_vec(
                    layer.ffn_norm.data.clone(),
                    (layer.ffn_norm.cols as usize,),
                    device,
                )?,
                config.rms_norm_eps,
            );

            blocks.push(Block { rms_1, attn, rms_2, mlp });
        }

        Ok(Self { wte, blocks, ln_f, lm_head })
    }
}
