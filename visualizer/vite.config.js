// vite.config.js — KAI 3D cognitive monitor
//
// Serves the live brain data from C:\KAI\data\ at /data/* so main.js can
// fetch('/data/kai_ticks.csv') and see the real ticks CSV that the Rust
// brain writes. Without this, the monitor falls back to random simulated
// data because Vite only serves files inside the visualizer folder by
// default.

import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The KAI data folder sits one level above the visualizer: C:\KAI\data
const KAI_DATA_DIR = path.resolve(__dirname, '..', 'data');

export default defineConfig({
    server: {
        port: 5173,
        host: true, // expose on LAN
        fs: {
            // Allow Vite to read files outside the project root (the CSV)
            allow: ['..'],
        },
    },
    plugins: [
        {
            name: 'kai-data-bridge',
            configureServer(server) {
                // Intercept requests to /data/* and stream the file from
                // C:\KAI\data\. This is how the 3D monitor sees the
                // brain's live ticks CSV without copying files around.
                server.middlewares.use('/data', (req, res, next) => {
                    const rel = decodeURIComponent((req.url || '/').split('?')[0]);
                    const abs = path.join(KAI_DATA_DIR, rel);

                    // Hard safety: don't allow ../ traversal outside
                    // the data folder.
                    if (!abs.startsWith(KAI_DATA_DIR)) {
                        res.statusCode = 403;
                        res.end('forbidden');
                        return;
                    }

                    fs.stat(abs, (err, stat) => {
                        if (err || !stat.isFile()) {
                            next();
                            return;
                        }
                        // CSVs served as text/plain with no-cache so the
                        // monitor always sees the latest tick row.
                        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                        res.setHeader('Cache-Control', 'no-store');
                        fs.createReadStream(abs).pipe(res);
                    });
                });
            },
        },
    ],
});
