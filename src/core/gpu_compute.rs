use wgpu::util::DeviceExt;
use crate::core::SparseVec;

const DIM: usize = 16384;
const WORDS: usize = DIM / 32;

/// Result of a GPU Boid force pass (ternary bitpack, exact O(N²) without VRAM ceiling).
pub struct BoidForceResult {
    /// Bundle sums: [N × WORDS] i32 accumulators for new ternary position.
    pub bundle_sums: Vec<i32>,
}

pub fn pack_ternary(v: &SparseVec) -> (Vec<u32>, Vec<u32>) {
    let mut pos = vec![0u32; WORDS];
    let mut neg = vec![0u32; WORDS];
    for (d, &val) in v.to_dense().iter().enumerate() {
        let word = d / 32;
        let bit  = d % 32;
        match val {
             1 => pos[word] |= 1u32 << bit,
            -1 => neg[word] |= 1u32 << bit,
             _ => {}
        }
    }
    (pos, neg)
}

pub fn threshold_bundle(bundle: &[i32], n: usize) -> Vec<i8> {
    let thr = (n as i32 / 4).max(1);
    let mut out = Vec::with_capacity(bundle.len() * 32);
    for &ws in bundle {
        for bit in 0..32u32 {
            let v = if ws > thr { 1i8 } else if ws < -thr { -1i8 } else { 0i8 };
            let _ = bit;
            out.push(v);
        }
    }
    out
}

pub struct GpuCompute {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    boid_pipeline: wgpu::ComputePipeline,
    boid_bind_group_layout: wgpu::BindGroupLayout,
    active_region: std::sync::atomic::AtomicU32,
}

impl GpuCompute {
    pub async fn new() -> Option<Self> {
        let instance = wgpu::Instance::default();
        let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }).await?;

        let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("Compute Device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            memory_hints: Default::default(),
        }, None).await.ok()?;

        let cs_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Cosine Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("cosine.wgsl").into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Cosine Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: false }, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Cosine Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Cosine Pipeline"),
            layout: Some(&pipeline_layout),
            module: &cs_module,
            entry_point: "main",
            compilation_options: Default::default(),
            cache: None,
        });

        // Boid (v3) bind group layout — 4 bindings
        let boid_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Boid Forces Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("boid_forces.wgsl").into()),
        });

        let boid_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Boid Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry { // pos_bits
                    binding: 0, visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { // neg_bits
                    binding: 1, visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { // params
                    binding: 2, visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { // bundle_sums
                    binding: 3, visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: false }, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
            ],
        });

        let boid_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Boid Pipeline Layout"),
            bind_group_layouts: &[&boid_bind_group_layout],
            push_constant_ranges: &[],
        });

        let boid_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Boid Pipeline"),
            layout: Some(&boid_pipeline_layout),
            module: &boid_shader,
            entry_point: "main",
            compilation_options: Default::default(),
            cache: None,
        });

        Some(Self {
            device, queue, pipeline, bind_group_layout,
            boid_pipeline, boid_bind_group_layout,
            active_region: std::sync::atomic::AtomicU32::new(0),
        })
    }

    pub fn update_active_region(&self, region: u32) {
        self.active_region.store(region, std::sync::atomic::Ordering::Relaxed);
    }

    pub async fn batch_cosine(&self, query: &SparseVec, targets: &[&SparseVec]) -> Vec<f32> {
        let n = targets.len();
        if n == 0 { return vec![]; }
        
        let mut query_data: Vec<i32> = Vec::with_capacity(DIM);
        let qd = query.to_dense();
        for &b in &qd { query_data.push(b as i32); }
        let mut target_data: Vec<i32> = Vec::with_capacity(n * DIM);
        for t in targets { let td = t.to_dense(); for &b in &td { target_data.push(b as i32); } }

        let query_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Query Buffer"), contents: bytemuck::cast_slice(&query_data),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let target_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Target Buffer"), contents: bytemuck::cast_slice(&target_data),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let output_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Output Buffer"), size: (n * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Cosine Bind Group"), layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: query_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: target_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: output_buffer.as_entire_binding() },
            ],
        });

        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(n as u32, 1, 1);
        }

        let staging_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Staging Buffer"), size: (n * 4) as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        encoder.copy_buffer_to_buffer(&output_buffer, 0, &staging_buffer, 0, (n * 4) as u64);
        self.queue.submit(Some(encoder.finish()));

        let (tx, rx) = std::sync::mpsc::channel();
        staging_buffer.slice(..).map_async(wgpu::MapMode::Read, move |v| { let _ = tx.send(v); });
        self.device.poll(wgpu::Maintain::Wait);

        if let Ok(Ok(_)) = rx.recv() {
            let data = staging_buffer.slice(..).get_mapped_range();
            let scores: Vec<f32> = bytemuck::cast_slice(&data).to_vec();
            drop(data); staging_buffer.unmap();
            
            let mut normalized = Vec::with_capacity(n);
            let q_norm = query.magnitude();
            for (i, &dot) in scores.iter().enumerate() {
                let t_norm = targets[i].magnitude();
                if q_norm > 0.0 && t_norm > 0.0 { normalized.push(dot / (q_norm * t_norm)); }
                else { normalized.push(0.0); }
            }
            normalized
        } else { vec![0.0; n] }
    }

    pub async fn run_boid_forces(
        &self,
        cell_vecs: &[SparseVec],
        sep_weight: i32,
        coh_weight: i32,
        anchor_weight: i32,
    ) -> BoidForceResult {
        let n = cell_vecs.len();
        if n < 2 { return BoidForceResult { bundle_sums: vec![] }; }

        let mut pos_flat: Vec<u32> = Vec::with_capacity(n * WORDS);
        let mut neg_flat: Vec<u32> = Vec::with_capacity(n * WORDS);
        for v in cell_vecs {
            let (p, ng) = pack_ternary(v);
            pos_flat.extend_from_slice(&p);
            neg_flat.extend_from_slice(&ng);
        }

        let params_raw: Vec<u32> = vec![
            n as u32,
            0.6f32.to_bits(), 0.15f32.to_bits(), 0.85f32.to_bits(),
            sep_weight as u32, coh_weight as u32, anchor_weight as u32,
            4.0f32.to_bits(), // Softmax Temperature
            self.active_region.load(std::sync::atomic::Ordering::Relaxed),
        ];

        let bundle_bytes = (n * WORDS * 4) as u64;

        let pos_buf = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Pos Bits"), contents: bytemuck::cast_slice(&pos_flat),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let neg_buf = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Neg Bits"), contents: bytemuck::cast_slice(&neg_flat),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let params_buf = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Params"), contents: bytemuck::cast_slice(&params_raw),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let bundle_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Bundle Sums"), size: bundle_bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Boid v3"), layout: &self.boid_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: pos_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: neg_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: params_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: bundle_buf.as_entire_binding() },
            ],
        });

        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
            pass.set_pipeline(&self.boid_pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(n as u32, 1, 1);
        }

        let bun_stg = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Bun Stg"), size: bundle_bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        enc.copy_buffer_to_buffer(&bundle_buf, 0, &bun_stg, 0, bundle_bytes);
        self.queue.submit(Some(enc.finish()));

        let (tx, rx) = std::sync::mpsc::channel();
        bun_stg.slice(..).map_async(wgpu::MapMode::Read, move |v| { let _ = tx.send(v); });
        self.device.poll(wgpu::Maintain::Wait);

        let bundle_sums = if rx.recv().map(|r| r.is_ok()).unwrap_or(false) {
            let d = bun_stg.slice(..).get_mapped_range();
            let v = bytemuck::cast_slice::<u8, i32>(&d).to_vec();
            drop(d); bun_stg.unmap(); v
        } else { vec![0i32; n * WORDS] };

        BoidForceResult { bundle_sums }
    }
}
