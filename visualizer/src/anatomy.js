/**
 * anatomy.js - 3D Anatomical Mapping for KAI's 78-Module Architecture
 *
 * Coordinates are normalized to a roughly brain-shaped space:
 *   x: [-50, 50] (Left-Right)
 *   y: [-40, 60] (Inferior-Superior)
 *   z: [-60, 50] (Posterior-Anterior)
 *
 * These coordinates are multiplied by coordinateScale / 50 (currently 1.7×)
 * when rendered so that the full module space roughly matches the scale of
 * the brain.glb shell.
 */

export const ANATOMY_MAP = {
    // Frontal Lobe (Anterior)
    "pfc": { x: 0, y: 30, z: 45, label: "PFC", region: "frontal" },
    "dlpfc": { x: 35, y: 35, z: 35, label: "dLPFC", region: "frontal" },
    "mpfc": { x: 0, y: 40, z: 50, label: "mPFC", region: "frontal" },
    "dmpfc": { x: 0, y: 50, z: 30, label: "dmPFC", region: "frontal" },
    "vmpfc": { x: 0, y: 10, z: 55, label: "vmPFC", region: "frontal" },
    "ofc": { x: 0, y: -5, z: 55, label: "OFC", region: "frontal" },
    "broca": { x: -45, y: 10, z: 35, label: "Broca", region: "frontal" },

    // Middle / Cingulate
    "acc": { x: 0, y: 25, z: 30, label: "ACC", region: "medial" },
    "mcc": { x: 0, y: 30, z: 0, label: "MCC", region: "medial" },
    "pcc": { x: 0, y: 25, z: -35, label: "PCC", region: "medial" },
    "sgacc": { x: 0, y: 5, z: 40, label: "sgACC", region: "medial" },

    // Limbic / Subcortical (Deep)
    "amygdala": { x: 22, y: -15, z: -5, label: "Amygdala", region: "limbic" },
    "amygdala_l": { x: -22, y: -15, z: -5, label: "Amygdala (L)", region: "limbic" },
    "hippocampus": { x: 25, y: -15, z: -25, label: "Hippocampus", region: "limbic" },
    "hippocampus_l": { x: -25, y: -15, z: -25, label: "Hippocampus (L)", region: "limbic" },
    "thalamus": { x: 0, y: -5, z: -10, label: "Thalamus", region: "limbic" },
    "nucleus_accumbens": { x: 10, y: -10, z: 15, label: "NAc", region: "limbic" },
    "ventral_pallidum": { x: 12, y: -8, z: 10, label: "Pallidum", region: "limbic" },
    "hypothalamus": { x: 0, y: -15, z: 5, label: "Hypothalamus", region: "limbic" },

    // Temporal / Social
    "tpj": { x: 55, y: 20, z: -25, label: "TPJ", region: "temporal" },
    "sts": { x: 60, y: 0, z: -10, label: "STS", region: "temporal" },
    "insula": { x: 40, y: 10, z: 10, label: "Insula", region: "temporal" },
    "insula_l": { x: -40, y: 10, z: 10, label: "Insula (L)", region: "temporal" },
    "temporal_poles": { x: 45, y: -10, z: 40, label: "TempPole", region: "temporal" },
    "wernicke": { x: -55, y: 15, z: -30, label: "Wernicke", region: "temporal" },

    // Parietal / Support
    "precuneus": { x: 0, y: 50, z: -45, label: "Precuneus", region: "parietal" },
    "angular_gyrus": { x: 45, y: 40, z: -55, label: "AngGyrus", region: "parietal" },
    "ipl": { x: 50, y: 45, z: -40, label: "IPL", region: "parietal" },
    "global_workspace": { x: 0, y: 20, z: 0, label: "GWorkspace", region: "central" },
    "claustrum": { x: 28, y: 5, z: 5, label: "Claustrum", region: "central" },

    // Midbrain / Brainstem (Base)
    "vta": { x: 0, y: -25, z: -15, label: "VTA", region: "stem" },
    "substantia_nigra": { x: 10, y: -25, z: -15, label: "SNc", region: "stem" },
    "raphe": { x: 0, y: -35, z: -25, label: "Raphe", region: "stem" },
    "locus_coeruleus": { x: 5, y: -40, z: -30, label: "LC", region: "stem" },
    "ras": { x: 0, y: -45, z: -35, label: "RAS", region: "stem" },
    "pontine_nuclei": { x: 0, y: -30, z: -40, label: "Pons", region: "stem" },
    "cerebellum": { x: 0, y: -40, z: -65, label: "Cerebellum", region: "stem" },

    // Neurotransmitters / Fields (Abstract Global — not rendered as volumes)
    "dopamine": { x: 0, y: 0, z: 0, label: "DA", region: "field" },
    "serotonin": { x: 0, y: 2, z: 0, label: "5-HT", region: "field" },
    "norepinephrine": { x: 0, y: 4, z: 0, label: "NE", region: "field" },
    "oxytocin": { x: 0, y: -2, z: 0, label: "OT", region: "field" },
    "cortisol": { x: 0, y: -4, z: 0, label: "CORT", region: "field" },

    // The Spiral
    "spiral_field": { x: 0, y: 0, z: 0, label: "Spiral", region: "field" }
};

/**
 * REGION_SHAPES — per-region anatomical ellipsoid definitions.
 *
 * Each region is rendered as a single soft ellipsoid (not a bulged sphere)
 * sized and placed so it fills the anatomical volume of that region without
 * extruding past the brain shell.
 *
 * Coordinates are in the same base space as ANATOMY_MAP (multiplied by
 * 85/50 = 1.7× in world units). Half-axes (rx, ry, rz) are chosen so the
 * ellipsoid, when placed at (cx, cy, cz), stays inside the brain's
 * bounding ellipsoid of roughly x±55, y∈[-45,55], z∈[-60,55].
 *
 *   lateral:  mirrored R↔L (two volumes)
 *   midline:  drawn once at x=0 (single volume)
 *   hidden:   not rendered — kept in ANATOMY_MAP for labels only
 */
export const REGION_SHAPES = {
    // Frontal lobe — large rounded mass filling the anterior skull.
    // Wide in both hemispheres, deep front-to-back so the auto-fit
    // brain shell picks up the full length of the prefrontal cortex.
    frontal:  { lateral: true,  cx: 24, cy: 22, cz: 32, rx: 24, ry: 20, rz: 20 },

    // Cingulate + sgACC — a long narrow ribbon wrapping the medial
    // surface along the whole front-to-back axis of the cingulate.
    medial:   { midline: true,  cx: 0,  cy: 20, cz: -2, rx: 9,  ry: 16, rz: 36 },

    // Limbic (amygdala + hippocampus + NAc + hypothalamus) — deep
    // temporal lobe mass, elongated along the hippocampal axis.
    limbic:   { lateral: true,  cx: 20, cy: -10, cz: -8, rx: 14, ry: 12, rz: 22 },

    // Temporal lobe + insula + TPJ — wraps laterally along the sylvian
    // fissure, tall and deep to fill the temporal-parietal junction.
    temporal: { lateral: true,  cx: 38, cy: 4,  cz: -6, rx: 14, ry: 18, rz: 24 },

    // Parietal (precuneus + angular + IPL) — top of the brain, flattened
    // disk sitting just under the upper skull. Pulled in/down so it
    // doesn't crown above the cortex.
    parietal: { lateral: true,  cx: 20, cy: 30, cz: -30, rx: 18, ry: 12, rz: 18 },

    // Central hub (global workspace + claustrum) — deep interior mass.
    central:  { lateral: true,  cx: 12, cy: 8,  cz: 0,  rx: 12, ry: 12, rz: 14 },

    // Brainstem + cerebellum — midline posterior-inferior. Cerebellum
    // is wider than brainstem, so rx allows lateral lobes, ry/rz keep
    // it tight at the base of the skull.
    stem:     { midline: true,  cx: 0,  cy: -28, cz: -30, rx: 20, ry: 14, rz: 22 },

    // Neurotransmitter fields — diffuse global modulators, not
    // anatomical volumes. Hidden to prevent the old "white blowout".
    field:    { hidden: true }
};

// Per-region palette (hex). Kept separate so visual tweaks don't require
// editing geometry data.
export const REGION_COLORS = {
    frontal:  0x00cfff,  // Cool cyan — executive
    medial:   0x00ffcc,  // Mint — cingulate/salience
    limbic:   0xff3388,  // Magenta — emotional core
    temporal: 0x44ff88,  // Lime — social/language
    parietal: 0x9944ff,  // Violet — attention/integration
    central:  0xffaa00,  // Amber — conductor/workspace
    stem:     0x22ff88,  // Green — modulator sources
    field:    0x00ffff   // Cyan (hidden)
};

// Procedural generation helper to fill missing entries from the 78 list
export const getFullMap = () => {
    const fullMap = { ...ANATOMY_MAP };
    return fullMap;
};
