use wgpu::util::DeviceExt;
use crate::core::sparse_vec::PackedMask;

pub struct GpuKernel {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub pipeline: wgpu::ComputePipeline,
    pub lattice_buffer: wgpu::Buffer,
    pub lattice_norms: Vec<f32>,
    pub n_cells: usize,
}

impl GpuKernel {
    pub async fn new(lattice: &[PackedMask]) -> Option<Self> {
        let instance = wgpu::Instance::default();
        let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }).await?;

        let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("GPU Compute Device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            memory_hints: Default::default(),
        }, None).await.ok()?;

        let shader_src = include_str!("../../shaders/cosine_packed.wgsl");
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("cosine_packed"),
            source: wgpu::ShaderSource::Wgsl(shader_src.into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("cosine_packed bgl"),
            entries: &[
                bgl_entry(0, true),  // lattice (storage, read_only)
                bgl_entry(1, true),  // queries (storage, read_only)
                bgl_entry(2, false), // scores (storage, read_write)
                wgpu::BindGroupLayoutEntry { // params (uniform)
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("cosine_packed pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("cosine_packed pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: "main",
            compilation_options: Default::default(),
            cache: None,
        });

        // Flatten lattice into flat u32 array: 1024 u32 words per cell
        let mut flat_lattice = vec![0u32; lattice.len() * 1024];
        for (i, m) in lattice.iter().enumerate() {
            let offset = i * 1024;
            for w in 0..1024 {
                let byte_idx = w * 4;
                flat_lattice[offset + w] = u32::from_le_bytes(m.data[byte_idx..byte_idx+4].try_into().unwrap());
            }
        }

        let lattice_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("lattice_buffer"),
            contents: bytemuck::cast_slice(&flat_lattice),
            usage: wgpu::BufferUsages::STORAGE,
        });

        let lattice_norms: Vec<f32> = lattice.iter().map(|m| m.cached_norm).collect();

        Some(Self {
            device,
            queue,
            pipeline,
            lattice_buffer,
            lattice_norms,
            n_cells: lattice.len(),
        })
    }

    pub async fn run_batch(&self, queries: &[PackedMask]) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let n_queries = queries.len();
        if n_queries == 0 { return Ok(vec![]); }

        // Flatten queries into flat u32 array: 1024 u32 words per query
        let mut flat_queries = vec![0u32; n_queries * 1024];
        for (i, m) in queries.iter().enumerate() {
            let offset = i * 1024;
            for w in 0..1024 {
                let byte_idx = w * 4;
                flat_queries[offset + w] = u32::from_le_bytes(m.data[byte_idx..byte_idx+4].try_into().unwrap());
            }
        }

        let queries_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("queries_buffer"),
            contents: bytemuck::cast_slice(&flat_queries),
            usage: wgpu::BufferUsages::STORAGE,
        });

        let scores_size = (n_queries * self.n_cells * 4) as u64;
        let scores_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scores_buffer"),
            size: scores_size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });

        let readback_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback_buffer"),
            size: scores_size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Params uniform buffer
        let params_data = [self.n_cells as u32, n_queries as u32];
        let params_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("params_buffer"),
            contents: bytemuck::cast_slice(&params_data),
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let bind_group_layout = self.pipeline.get_bind_group_layout(0);
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("cosine_packed bg"),
            layout: &bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.lattice_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: queries_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: scores_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: params_buffer.as_entire_binding() },
            ],
        });

        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            let workgroups_x = (self.n_cells as u32 + 63) / 64;
            let workgroups_y = n_queries as u32;
            pass.dispatch_workgroups(workgroups_x, workgroups_y, 1);
        }
        encoder.copy_buffer_to_buffer(&scores_buffer, 0, &readback_buffer, 0, scores_size);
        self.queue.submit(std::iter::once(encoder.finish()));

        let slice = readback_buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| { tx.send(r).unwrap(); });
        self.device.poll(wgpu::Maintain::Wait);
        rx.recv()??;

        let data = slice.get_mapped_range();
        let raw_scores: &[f32] = bytemuck::cast_slice(&data);

        // Normalize raw dot products to cosine similarity
        let mut final_scores = vec![0.0f32; n_queries * self.n_cells];
        for q in 0..n_queries {
            let q_norm = queries[q].cached_norm;
            for c in 0..self.n_cells {
                let idx = q * self.n_cells + c;
                let dot = raw_scores[idx];
                let c_norm = self.lattice_norms[c];
                final_scores[idx] = if q_norm > 0.0 && c_norm > 0.0 {
                    dot / (q_norm * c_norm)
                } else {
                    0.0
                };
            }
        }

        drop(data);
        readback_buffer.unmap();

        Ok(final_scores)
    }
}

fn bgl_entry(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding, visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false, min_binding_size: None,
        },
        count: None,
    }
}
