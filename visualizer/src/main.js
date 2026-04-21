import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass';
import { gsap } from 'gsap';
import { ANATOMY_MAP, REGION_SHAPES, REGION_COLORS } from './anatomy';

// --- CONFIG ---
const BRAIN_MODEL_URL = 'https://raw.githubusercontent.com/pmndrs/drei-assets/master/brain.glb';
const CSV_URL = '/data/kai_ticks.csv';
const POLL_INTERVAL = 1000;
// Ticks/min window — mirrors the 2D monitor's `r60` computation.
const TPM_WINDOW_SECS = 60;

class BrainVisualizer {
    constructor() {
        this.container = document.getElementById('app');
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.controls = null;
        this.composer = null;
        this.brain = null;
        this.nodes = {};

        // Live brain metrics. Mirrors the 2D monitor's vitals layout:
        // phi_g, rho, chi, valence, tau_r, plus mood and ticks/min.
        this.metrics = {
            phi: 0, rho: 0, chi: 0, val: 0, tau: 0,
            mood: 'stable', tpm: 0.0, tick: 0,
        };
        this.liveState = 'loading'; // 'loading' | 'live' | 'no-data'
        this.columnIndex = null;    // map of column name → index, parsed once

        this.init();
    }

    async init() {
        // Renderer setup
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.toneMapping = THREE.ReinhardToneMapping;
        this.container.appendChild(this.renderer.domElement);

        // Camera & Controls
        this.camera.position.set(0, 50, 150);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.autoRotate = false; // Stopped auto-rotation per request
        this.controls.autoRotateSpeed = 0.5;

        // Post-processing (Bloom for Glow)
        const renderScene = new RenderPass(this.scene, this.camera);
        const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.2, 0.4, 0.85);
        bloomPass.threshold = 0.5;
        bloomPass.strength = 0.25;
        bloomPass.radius = 1.0;

        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(renderScene);
        this.composer.addPass(bloomPass);

        // Subtler Bloom for professional look
        bloomPass.strength = 0.15; // Toned down from 0.25 to avoid blowout
        bloomPass.radius = 0.5;

        // Lights (Centralized for Medical Depth)
        const ambientLight = new THREE.AmbientLight(0x202020, 0.4);
        this.scene.add(ambientLight);
        
        // Internal "Neural Sync" PointLight
        const coreLight = new THREE.PointLight(0xffffff, 1.5, 300);
        coreLight.position.set(0, 0, 0);
        this.scene.add(coreLight);

        // Grid removed per request

        // Create Modules first so we have the target center for alignment
        this.createModules();

        // Load Brain Shell
        this.loadBrain();

        // Start Data Polling
        this.startPolling();

        // Resize handler
        window.addEventListener('resize', () => this.onResize());

        // Animation Loop
        this.animate();
    }

    loadBrain() {
        const loader = new GLTFLoader();
        const modelUrl = '/models/brain.glb'; 
        
        loader.load(modelUrl, (gltf) => {
            this.brain = gltf.scene;
            this.prepareBrainMesh();
            console.log("Bio-Machine high-fidelity shell integrated.");
        }, undefined, (error) => {
            console.error('Anatomical GLB failed to load', error);
        });
    }

    prepareBrainMesh() {
        if (!this.brain || !this.modulesGroup || this.modulesGroup.children.length === 0) {
            console.warn("Anatomy not ready for shell alignment, retrying...");
            setTimeout(() => this.prepareBrainMesh(), 100);
            return;
        }

        // 1. Full Bilateral Brain (Mirroring)
        if (this.brainGroup) this.scene.remove(this.brainGroup);
        this.brainGroup = new THREE.Group();

        const brainCopy = this.brain.clone();
        brainCopy.scale.x = -1;
        this.brainGroup.add(this.brain);
        this.brainGroup.add(brainCopy);
        this.scene.add(this.brainGroup);

        // 2. Auto-fit: scale the brain so it *fully contains* the module
        //    cloud on every axis, with a small margin. The previous
        //    hard-coded 160× was arbitrary and smaller than the module
        //    coordinate space on some axes — which is why parietal and
        //    stem modules were visible outside the shell.
        this.brainGroup.scale.set(1, 1, 1);
        this.brainGroup.position.set(0, 0, 0);
        this.brainGroup.updateMatrixWorld(true);

        const modulesBox = new THREE.Box3();
        this.modulesGroup.children.forEach(group => {
            group.children.forEach(child => {
                if (!child.isMesh) return;
                // Expand by the module's *scaled* bounding sphere — the
                // ellipsoid radius, not just the centroid — so the
                // containing brain has room for the whole shape.
                const pos = child.getWorldPosition(new THREE.Vector3());
                const s = child.scale;
                const r = Math.max(s.x, s.y, s.z);
                modulesBox.expandByPoint(new THREE.Vector3(pos.x + r, pos.y + r, pos.z + r));
                modulesBox.expandByPoint(new THREE.Vector3(pos.x - r, pos.y - r, pos.z - r));
            });
        });

        const unitShellBox = new THREE.Box3();
        this.brainGroup.traverse(obj => {
            if (obj.isMesh) unitShellBox.expandByObject(obj);
        });

        const modulesSize = new THREE.Vector3();
        modulesBox.getSize(modulesSize);
        const unitShellSize = new THREE.Vector3();
        unitShellBox.getSize(unitShellSize);

        // Pick the scale that makes the brain just barely contain the
        // module cloud on its tightest axis, with a 15% margin for
        // breathing room. Uniform scale keeps the brain's real shape.
        const margin = 1.18;
        const sx = (modulesSize.x * margin) / unitShellSize.x;
        const sy = (modulesSize.y * margin) / unitShellSize.y;
        const sz = (modulesSize.z * margin) / unitShellSize.z;
        const scale = Math.max(sx, sy, sz);
        this.brainGroup.scale.setScalar(scale);
        this.brainGroup.updateMatrixWorld(true);

        // Now align the brain's center to the module cloud's center.
        const shellBox = new THREE.Box3();
        this.brainGroup.traverse(obj => {
            if (obj.isMesh) shellBox.expandByObject(obj);
        });
        const modulesCenter = new THREE.Vector3();
        modulesBox.getCenter(modulesCenter);
        const shellCenter = new THREE.Vector3();
        shellBox.getCenter(shellCenter);
        this.brainGroup.position.copy(modulesCenter).sub(shellCenter);
        this.brainGroup.updateMatrixWorld(true);

        // Record the *real* world-space shell bounds for the refit pass.
        this.realShellBox = new THREE.Box3();
        this.brainGroup.traverse(obj => {
            if (obj.isMesh) this.realShellBox.expandByObject(obj);
        });

        // 3. Brain shell appearance: a soft translucent tissue shell with
        //    a faint wire overlay. Additive blending kept subtle so it
        //    never washes out the modules inside.
        const allMeshes = [];
        this.brainGroup.traverse(n => { if (n.isMesh) allMeshes.push(n); });

        allMeshes.forEach((mesh) => {
            mesh.material = new THREE.MeshPhysicalMaterial({
                color: 0x003a55,
                emissive: 0x001122,
                emissiveIntensity: 0.08,
                transparent: true,
                opacity: 0.09,
                metalness: 0,
                roughness: 1.0,
                transmission: 0.85,
                ior: 1.1,
                thickness: 1.0,
                side: THREE.DoubleSide,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            });

            const wire = new THREE.Mesh(mesh.geometry.clone(), new THREE.MeshBasicMaterial({
                color: 0x00e0f0,
                wireframe: true,
                transparent: true,
                opacity: 0.04,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            }));
            wire.userData.isWire = true;
            mesh.add(wire);
        });

        // 4. Refit modules: now that we know the real shell bounds in
        //    world units, clamp every module so it sits fully inside
        //    the brain. This is the guarantee nothing extrudes.
        this.refitModulesToShell();
    }

    /// After the brain shell is in place, walk every module and shrink
    /// its ellipsoid scale on any axis where it would poke past the
    /// shell. Also shift the module center inward if necessary.
    refitModulesToShell() {
        if (!this.realShellBox) return;
        const shellMin = this.realShellBox.min;
        const shellMax = this.realShellBox.max;
        const gap = 6; // world-unit gap to maintain inside the shell

        Object.values(this.volumes).forEach(arr => {
            arr.forEach(b => {
                const mesh = b.mesh;
                const pos = mesh.position.clone();
                let { x: rx, y: ry, z: rz } = b.baseScale;

                // X
                if (pos.x + rx > shellMax.x - gap) rx = Math.max(6, shellMax.x - gap - pos.x);
                if (pos.x - rx < shellMin.x + gap) rx = Math.max(6, pos.x - (shellMin.x + gap));
                // Y
                if (pos.y + ry > shellMax.y - gap) ry = Math.max(6, shellMax.y - gap - pos.y);
                if (pos.y - ry < shellMin.y + gap) ry = Math.max(6, pos.y - (shellMin.y + gap));
                // Z
                if (pos.z + rz > shellMax.z - gap) rz = Math.max(6, shellMax.z - gap - pos.z);
                if (pos.z - rz < shellMin.z + gap) rz = Math.max(6, pos.z - (shellMin.z + gap));

                // If the anatomical center itself is outside the shell
                // (rare, but can happen with coord-scale mismatches),
                // pull the center to the nearest shell surface.
                pos.x = Math.min(Math.max(pos.x, shellMin.x + gap + rx),
                                 shellMax.x - gap - rx);
                pos.y = Math.min(Math.max(pos.y, shellMin.y + gap + ry),
                                 shellMax.y - gap - ry);
                pos.z = Math.min(Math.max(pos.z, shellMin.z + gap + rz),
                                 shellMax.z - gap - rz);
                mesh.position.copy(pos);

                b.baseScale = { x: rx, y: ry, z: rz };
                mesh.scale.set(rx, ry, rz);

                // Reposition the region label sibling if we moved the
                // module center.
                if (b.labelSprite) {
                    b.labelSprite.position.set(pos.x, pos.y + ry + 6, pos.z);
                }
            });
        });
    }

    createModules() {
        this.modulesGroup = new THREE.Group();
        this.scene.add(this.modulesGroup);

        // Base-coords → world-coords multiplier. The brain shell then
        // auto-fits around the module cloud in prepareBrainMesh(), so
        // modules effectively define the brain's overall size and the
        // anatomical proportions (rx/ry/rz per region) determine shape.
        this.coordinateScale = 85 / 50; // 1.7×
        this.volumes = {};

        // For label anchoring, map a canonical "major node" id to each
        // region so we label one representative structure per volume.
        const regionLabelNode = {
            frontal:  "pfc",
            medial:   "acc",
            limbic:   "amygdala",
            temporal: "insula",
            parietal: "precuneus",
            central:  "global_workspace",
            stem:     "cerebellum"
        };

        // Group nodes by region so we can pick representative labels and
        // (later) per-module pulse targets without re-scanning the map.
        const regionsGrouped = {};
        Object.entries(ANATOMY_MAP).forEach(([id, data]) => {
            if (!regionsGrouped[data.region]) regionsGrouped[data.region] = [];
            regionsGrouped[data.region].push({ id, ...data });
        });

        Object.entries(REGION_SHAPES).forEach(([regionId, shape]) => {
            if (shape.hidden) return;
            const color = REGION_COLORS[regionId] || 0x00cfff;
            const nodes = regionsGrouped[regionId] || [];

            const sides = shape.midline ? ["M"] : ["R", "L"];
            sides.forEach(side => {
                const sideGroup = new THREE.Group();
                this.modulesGroup.add(sideGroup);

                // Build an anatomically-shaped volume from a smooth unit
                // icosahedron. The shape gets its anatomy from non-uniform
                // scale on x/y/z (not from vertex bulging — that's what
                // caused the previous spikes). A tiny pseudo-random
                // displacement makes the surface feel like tissue rather
                // than polished glass.
                const volumeGeo = new THREE.IcosahedronGeometry(1, 4);
                const posAttr = volumeGeo.attributes.position;
                for (let i = 0; i < posAttr.count; i++) {
                    const x = posAttr.getX(i);
                    const y = posAttr.getY(i);
                    const z = posAttr.getZ(i);
                    // Small coherent noise: 3% surface roughness.
                    const n = 1.0
                        + Math.sin(x * 4.1 + y * 2.7) * 0.015
                        + Math.cos(y * 3.3 + z * 2.1) * 0.015;
                    posAttr.setXYZ(i, x * n, y * n, z * n);
                }
                volumeGeo.computeVertexNormals();

                // Tissue-like material: high opacity, low transmission,
                // matte roughness. Modules read as dense matter inside
                // the brain, not hollow glass.
                const volumeMat = new THREE.MeshPhysicalMaterial({
                    color,
                    emissive: new THREE.Color(color).multiplyScalar(0.35),
                    emissiveIntensity: 0.25,
                    transparent: true,
                    opacity: 0.78,
                    transmission: 0.20,
                    thickness: 2.0,
                    ior: 1.30,
                    roughness: 0.65,
                    metalness: 0.0,
                    blending: THREE.NormalBlending,
                    side: THREE.DoubleSide,
                    depthWrite: true
                });

                const hullMesh = new THREE.Mesh(volumeGeo, volumeMat);

                // Anatomical ellipsoid scale (rx, ry, rz) in world units.
                const rx = shape.rx * this.coordinateScale;
                const ry = shape.ry * this.coordinateScale;
                const rz = shape.rz * this.coordinateScale;

                // Anatomical center, mirrored for L side.
                const sx = side === "L" ? -1 : 1;
                const cx = shape.cx * sx * this.coordinateScale;
                const cy = shape.cy * this.coordinateScale;
                const cz = shape.cz * this.coordinateScale;

                hullMesh.position.set(cx, cy, cz);
                hullMesh.scale.set(rx, ry, rz);

                sideGroup.add(hullMesh);

                const volumeEntry = {
                    mesh: hullMesh,
                    mat: volumeMat,
                    baseScale: { x: rx, y: ry, z: rz },
                    labelSprite: null
                };

                // Label anchor — only on R or midline, and as a SIBLING
                // of hullMesh (in sideGroup), so the sprite's position
                // is NOT multiplied by the ellipsoid scale. Sitting at
                // world position (cx, cy + ry + 6, cz) keeps the label
                // just above its module.
                if (side !== "L") {
                    const labelId = regionLabelNode[regionId];
                    const labelNode = nodes.find(n => n.id === labelId);
                    if (labelNode) {
                        const canvas = document.createElement('canvas');
                        canvas.width = 256; canvas.height = 48;
                        const ctx = canvas.getContext('2d');
                        ctx.fillStyle = 'rgba(0,0,0,0)';
                        ctx.clearRect(0, 0, 256, 48);
                        ctx.font = 'Bold 24px Roboto Mono, monospace';
                        ctx.textBaseline = 'middle';
                        ctx.fillStyle = '#ffffff';
                        ctx.shadowColor = '#000000';
                        ctx.shadowBlur = 6;
                        ctx.fillText(labelNode.label.toUpperCase(), 8, 24);
                        const txtMap = new THREE.CanvasTexture(canvas);
                        txtMap.needsUpdate = true;
                        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
                            map: txtMap,
                            transparent: true,
                            opacity: 0.85,
                            depthTest: false,
                            depthWrite: false
                        }));
                        sprite.position.set(cx, cy + ry + 6, cz);
                        sprite.scale.set(22, 4.2, 1);
                        sprite.renderOrder = 10;
                        sideGroup.add(sprite);
                        volumeEntry.labelSprite = sprite;
                    }
                }

                if (!this.volumes[regionId]) this.volumes[regionId] = [];
                this.volumes[regionId].push(volumeEntry);
            });
        });
    }

    async startPolling() {
        // Kick off an immediate fetch, then once per POLL_INTERVAL.
        // Each fetch gets a cache-busting query param so we never see a
        // stale CSV. If the fetch fails we show an honest NO-DATA state
        // instead of silently rendering random numbers.
        const poll = () => this.fetchLatestTick().catch(err => {
            console.warn('[kai-monitor] fetch failed:', err?.message || err);
            this.liveState = 'no-data';
            this.updateVisuals();
        });
        poll();
        setInterval(poll, POLL_INTERVAL);
    }

    async fetchLatestTick() {
        const url = `${CSV_URL}?t=${Date.now()}`;
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const lines = text.trim().split('\n');
        if (lines.length < 2) throw new Error('CSV has no data rows yet');

        // Parse the header once — by NAME, not by index — so the monitor
        // survives column re-orderings in the Rust brain. This is how
        // the 2D monitor stays correct too.
        if (!this.columnIndex) {
            const headers = lines[0].split(',').map(h => h.trim());
            this.columnIndex = {};
            headers.forEach((h, i) => { this.columnIndex[h] = i; });
            const required = ['timestamp', 'tick', 'phi_g', 'rho', 'chi',
                              'valence', 'tau_r', 'mood'];
            const missing = required.filter(r => !(r in this.columnIndex));
            if (missing.length > 0) {
                throw new Error(`CSV missing columns: ${missing.join(', ')}`);
            }
        }
        const col = this.columnIndex;

        // Parse the latest row for the "now" readout.
        const last = lines[lines.length - 1].split(',');
        const get = (name) => parseFloat(last[col[name]]);
        this.metrics.phi  = get('phi_g');
        this.metrics.rho  = get('rho');
        this.metrics.chi  = get('chi');
        this.metrics.val  = get('valence');
        this.metrics.tau  = get('tau_r');
        this.metrics.mood = (last[col['mood']] || 'stable').trim().toLowerCase();
        this.metrics.tick = parseInt(last[col['tick']] || '0', 10);

        // Ticks-per-minute over the last TPM_WINDOW_SECS. Mirrors the 2D
        // monitor's `r60` computation: count rows in the trailing 60s
        // window and divide by its span. This is what gives the heartbeat
        // readout — watching TPM drop to 0 means the brain stopped ticking.
        const tEnd = Date.parse(last[col['timestamp']]);
        if (!Number.isFinite(tEnd)) {
            this.metrics.tpm = 0.0;
        } else {
            const windowStart = tEnd - TPM_WINDOW_SECS * 1000;
            let rowsInWindow = 0;
            let tFirst = null;
            // Walk the tail of the CSV backwards — TPM only needs the
            // last minute, no need to scan the whole file.
            for (let i = lines.length - 1; i >= 1; i--) {
                const row = lines[i].split(',');
                const ts = Date.parse(row[col['timestamp']]);
                if (!Number.isFinite(ts) || ts < windowStart) break;
                rowsInWindow++;
                tFirst = ts;
            }
            if (rowsInWindow > 1 && tFirst != null) {
                const spanSec = (tEnd - tFirst) / 1000;
                this.metrics.tpm = spanSec > 0
                    ? ((rowsInWindow - 1) / spanSec) * 60.0
                    : 0.0;
            } else {
                this.metrics.tpm = 0.0;
            }
        }

        this.liveState = 'live';
        this.updateVisuals();
    }

    updateVisuals() {
        // DOM readout — matches the 2D monitor's vitals.
        const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '– – – –');
        const set = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.innerText = text;
        };
        set('m-phi', fmt(this.metrics.phi));
        set('m-rho', fmt(this.metrics.rho));
        set('m-chi', fmt(this.metrics.chi));
        set('m-val', fmt(this.metrics.val));
        set('m-tau', fmt(this.metrics.tau));
        set('m-mood', this.metrics.mood.toUpperCase());
        set('m-tpm', fmt(this.metrics.tpm, 1));
        set('m-tick', Number.isFinite(this.metrics.tick) ? String(this.metrics.tick) : '—');

        // Live/no-data banner
        const statusEl = document.getElementById('status');
        if (statusEl) {
            if (this.liveState === 'live') {
                statusEl.innerText = `LIVE // tick ${this.metrics.tick} // ${this.metrics.tpm.toFixed(1)} tpm`;
                statusEl.style.color = '#00ff88';
            } else if (this.liveState === 'no-data') {
                statusEl.innerText = 'NO DATA — is KAI running? Check C:\\KAI\\data\\kai_ticks.csv';
                statusEl.style.color = '#ff4466';
            } else {
                statusEl.innerText = 'LOADING…';
                statusEl.style.color = '#ffdd44';
            }
        }

        // If we don't have a live tick yet, skip the pulse — don't lie
        // about the brain's activity.
        if (this.liveState !== 'live') return;

        // 1. Regional Volumetric Pulsing
        //
        // Each region's activity is driven by the field metric that maps
        // most naturally to its function. The breathing scale is kept
        // small (≤6%) so the module never bulges past the shell margin
        // reserved by createModules().
        Object.entries(this.volumes).forEach(([regionId, blooms]) => {
            let activity = Math.min(1.0, this.metrics.phi * 2.0);
            if (regionId === 'medial')   activity = Math.min(1.0, this.metrics.chi * 4.0);
            if (regionId === 'frontal')  activity = Math.min(1.0, this.metrics.phi * 2.5);
            if (regionId === 'limbic')   activity = Math.min(1.0, Math.abs(this.metrics.val) * 2.0);
            if (regionId === 'stem')     activity = Math.min(1.0, this.metrics.tau * 1.5);
            if (regionId === 'parietal') activity = Math.min(1.0, this.metrics.rho * 3.0);
            if (regionId === 'central')  activity = Math.min(1.0, this.metrics.phi * 1.8);

            blooms.forEach(b => {
                // Glow: gentle emissive + opacity lift, never blowing out.
                gsap.to(b.mat, {
                    emissiveIntensity: 0.05 + activity * 0.45,
                    opacity: 0.30 + activity * 0.35,
                    duration: 0.4
                });

                // Breathing: scale about baseScale by up to 6%. Multiply
                // each axis independently so ellipsoid shape is preserved.
                const breath = 1.0 + activity * 0.06;
                gsap.to(b.mesh.scale, {
                    x: b.baseScale.x * breath,
                    y: b.baseScale.y * breath,
                    z: b.baseScale.z * breath,
                    duration: 0.4
                });
            });
        });
    }

    onResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        this.controls.update();
        this.composer.render();
    }
}

new BrainVisualizer();
