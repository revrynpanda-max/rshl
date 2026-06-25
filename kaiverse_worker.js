// --- KAIverse Web Worker for procedural generation offloading ---
importScripts('./kaiverse-wasm/pkg/kaiverse_wasm.js');

const wasm = wasm_bindgen;

wasm('./kaiverse-wasm/pkg/kaiverse_wasm_bg.wasm').then(() => {
    self.postMessage({ type: 'READY' });
}).catch(e => {
    console.error("Worker WASM load failed:", e);
});

self.onmessage = function(e) {
    if (e.data.type === 'GENERATE_TERRAIN') {
        const { id, seed, size, sharp, sea } = e.data;
        const total = size * size;
        const data = new Float32Array(total * 4); // RGBA for DataTexture
        
        for (let y = 0; y < size; y++) {
            let vy = (y / (size - 1)) * 2.0 - 1.0;
            for (let x = 0; x < size; x++) {
                let vx = (x / (size - 1)) * 2.0 - 1.0;
                
                // Map UV to sphere direction
                let d = Math.sqrt(vx*vx + vy*vy + 1.0);
                let nx = vx/d, ny = vy/d, nz = 1.0/d;
                
                // Call WASM
                let h = wasm.ns_terrain_height_wasm(nx, ny, nz, sharp, sea, seed);
                
                let idx = (y * size + x) * 4;
                data[idx] = h;     // R
                data[idx+1] = h;   // G
                data[idx+2] = h;   // B
                data[idx+3] = 1.0; // A
            }
        }
        
        // Transfer ArrayBuffer back to main thread via Structured Cloning
        self.postMessage({ type: 'RESULT', id, data }, [data.buffer]);
    }
};
