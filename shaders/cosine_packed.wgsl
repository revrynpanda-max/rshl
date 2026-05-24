struct Params {
    n_cells: u32,
    n_queries: u32,
}

@group(0) @binding(0) var<storage, read> lattice: array<u32>;   // n_cells × 1024 words
@group(0) @binding(1) var<storage, read> queries: array<u32>;   // n_queries × 1024 words
@group(0) @binding(2) var<storage, read_write> scores: array<f32>; // n_queries × n_cells
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let cell_idx = gid.x;
    let query_idx = gid.y;
    if (cell_idx >= params.n_cells || query_idx >= params.n_queries) {
        return;
    }

    let cell_offset = cell_idx * 1024u;
    let query_offset = query_idx * 1024u;

    var dot: i32 = 0;
    for (var w: u32 = 0u; w < 1024u; w = w + 1u) {
        let a = lattice[cell_offset + w];
        let b = queries[query_offset + w];

        let a_pos = a & 0x55555555u;
        let a_neg = (a >> 1u) & 0x55555555u;
        let b_pos = b & 0x55555555u;
        let b_neg = (b >> 1u) & 0x55555555u;

        let match_pos = (a_pos & b_pos) | (a_neg & b_neg);
        let match_neg = (a_pos & b_neg) | (a_neg & b_pos);

        dot = dot + i32(countOneBits(match_pos)) - i32(countOneBits(match_neg));
    }

    // Output flat 1D scores matrix [n_queries × n_cells]
    scores[query_idx * params.n_cells + cell_idx] = f32(dot);
}
