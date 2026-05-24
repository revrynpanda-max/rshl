@group(0) @binding(0) var<storage, read> query: array<i32>;
@group(0) @binding(1) var<storage, read> targets: array<i32>;
@group(0) @binding(2) var<storage, read_write> results: array<f32>;

const DIM: u32 = 16384u;

@compute @workgroup_size(256)
fn main(
    @builtin(global_invocation_id) global_id: vec3<u32>,
    @builtin(workgroup_id) group_id: vec3<u32>,
    @builtin(local_invocation_id) local_id: vec3<u32>
) {
    let target_idx = group_id.x;
    let local_thread = local_id.x;
    let workgroup_size = 256u;

    // Local shared memory for reduction
    var shared_sums: array<i32, 256>;

    // Each thread in the workgroup processes (16384 / 256) = 64 dimensions
    var dot: i32 = 0;
    for (var i = local_thread; i < DIM; i += workgroup_size) {
        let q_val = query[i];
        let t_val = targets[target_idx * DIM + i];
        dot += q_val * t_val;
    }

    // Store in shared memory for reduction
    shared_sums[local_thread] = dot;
    workgroupBarrier();

    // Parallel reduction
    for (var s = workgroup_size / 2u; s > 0u; s >>= 1u) {
        if (local_thread < s) {
            shared_sums[local_thread] += shared_sums[local_thread + s];
        }
        workgroupBarrier();
    }

    // Thread 0 writes the final sum to the results buffer
    if (local_thread == 0u) {
        results[target_idx] = f32(shared_sums[0]);
    }
}
