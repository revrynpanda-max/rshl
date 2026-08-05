//! Compact binary serialization for lattice cells.
//!
//! WHY: JSON stores each SparseVec as {"len":16384,"nz":[[0,1],...]}.
//! At 655 pairs per vector, each pair costs ~15 bytes in JSON = ~10KB per vector.
//! With 3 vectors per cell: ~30KB per cell. 17K cells = 575MB. Unacceptable.
//!
//! Compact binary: [nnz: u16] [indices: u16 x nnz] [sign flags: u8 x ceil(nnz/8)].
//! At nnz=655: 2 + 1310 + 82 = 1,394 bytes per vector. ~7x smaller than JSON.
//! Plus zstd compression: another 3-5x. Final: ~2.2KB per cell.

use std::io::{Read, Write};
use std::sync::Arc;
use crate::core::{Cell, SparseVec};
use crate::core::claim::Claim;
use crate::core::sparse_vec::DIM;

#[derive(Debug)]
pub enum CompactError {
    Io(std::io::Error),
    Corrupt(&'static str),
}

impl From<std::io::Error> for CompactError {
    fn from(e: std::io::Error) -> Self { CompactError::Io(e) }
}

// ── Low-level helpers ─────────────────────────────────────────────────────────

fn write_str<W: Write>(w: &mut W, s: &str) -> Result<(), CompactError> {
    let bytes = s.as_bytes();
    w.write_all(&(bytes.len() as u32).to_le_bytes())?;
    w.write_all(bytes)?;
    Ok(())
}

fn read_str<R: Read>(r: &mut R) -> Result<String, CompactError> {
    let mut buf4 = [0u8; 4];
    r.read_exact(&mut buf4)?;
    let len = u32::from_le_bytes(buf4) as usize;
    if len > 1_000_000 {
        return Err(CompactError::Corrupt("string too long"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    String::from_utf8(buf).map_err(|_| CompactError::Corrupt("invalid UTF-8"))
}

fn write_u32<W: Write>(w: &mut W, v: u32) -> Result<(), CompactError> {
    w.write_all(&v.to_le_bytes())?; Ok(())
}
fn read_u32<R: Read>(r: &mut R) -> Result<u32, CompactError> {
    let mut b = [0u8; 4]; r.read_exact(&mut b)?; Ok(u32::from_le_bytes(b))
}
fn write_u64<W: Write>(w: &mut W, v: u64) -> Result<(), CompactError> {
    w.write_all(&v.to_le_bytes())?; Ok(())
}
fn read_u64<R: Read>(r: &mut R) -> Result<u64, CompactError> {
    let mut b = [0u8; 8]; r.read_exact(&mut b)?; Ok(u64::from_le_bytes(b))
}
fn write_f32<W: Write>(w: &mut W, v: f32) -> Result<(), CompactError> {
    w.write_all(&v.to_le_bytes())?; Ok(())
}
fn read_f32<R: Read>(r: &mut R) -> Result<f32, CompactError> {
    let mut b = [0u8; 4]; r.read_exact(&mut b)?; Ok(f32::from_le_bytes(b))
}
fn write_u8<W: Write>(w: &mut W, v: u8) -> Result<(), CompactError> {
    w.write_all(&[v])?; Ok(())
}
fn read_u8<R: Read>(r: &mut R) -> Result<u8, CompactError> {
    let mut b = [0u8; 1]; r.read_exact(&mut b)?; Ok(b[0])
}
fn write_u32_vec<W: Write>(w: &mut W, v: &[u32]) -> Result<(), CompactError> {
    write_u32(w, v.len() as u32)?;
    for &item in v { write_u32(w, item)?; }
    Ok(())
}
fn read_u32_vec<R: Read>(r: &mut R) -> Result<Vec<u32>, CompactError> {
    let n = read_u32(r)? as usize;
    let mut v = Vec::with_capacity(n.min(10000));
    for _ in 0..n { v.push(read_u32(r)?); }
    Ok(v)
}

fn write_string_vec<W: Write>(w: &mut W, v: &[String]) -> Result<(), CompactError> {
    write_u32(w, v.len() as u32)?;
    for s in v { write_str(w, s)?; }
    Ok(())
}
fn read_string_vec<R: Read>(r: &mut R) -> Result<Vec<String>, CompactError> {
    let n = read_u32(r)? as usize;
    let mut v = Vec::with_capacity(n.min(1000));
    for _ in 0..n { v.push(read_str(r)?); }
    Ok(v)
}

// ── SparseVec compact I/O ───────────────────────────────────────────────────

fn write_sparsevec<W: Write>(w: &mut W, sv: &SparseVec) -> Result<(), CompactError> {
    let indices = &sv.nz;
    let nnz = indices.len() as u16;
    w.write_all(&nnz.to_le_bytes())?;
    if nnz == 0 { return Ok(()); }
    // Write indices as u16
    for &idx in indices {
        w.write_all(&(idx as u16).to_le_bytes())?;
    }
    // Pack signs into bitflags (1 bit per entry)
    let flag_bytes = ((nnz + 7) / 8) as usize;
    let mut flags = vec![0u8; flag_bytes];
    for (i, &val) in sv.vals.iter().enumerate() {
        if val > 0 {
            flags[i / 8] |= 1 << (i % 8);
        }
    }
    w.write_all(&flags)?;
    Ok(())
}

fn read_sparsevec<R: Read>(r: &mut R) -> Result<SparseVec, CompactError> {
    let mut b2 = [0u8; 2];
    r.read_exact(&mut b2)?;
    let nnz = u16::from_le_bytes(b2) as usize;
    if nnz == 0 { return Ok(SparseVec::zero()); }
    if nnz > DIM { return Err(CompactError::Corrupt("nnz exceeds DIM")); }

    let mut nz = vec![0u16; nnz];
    let mut idx_buf = vec![0u8; nnz * 2];
    r.read_exact(&mut idx_buf)?;
    for i in 0..nnz {
        nz[i] = u16::from_le_bytes([idx_buf[i*2], idx_buf[i*2+1]]);
    }

    let flag_bytes = (nnz + 7) / 8;
    let mut flags = vec![0u8; flag_bytes];
    r.read_exact(&mut flags)?;

    let mut vals = vec![0i8; nnz];
    for i in 0..nnz {
        vals[i] = if (flags[i / 8] >> (i % 8)) & 1 == 1 { 1 } else { -1 };
    }

    Ok(SparseVec::from_nz_vals(nz, vals))
}

// ── Cell I/O ────────────────────────────────────────────────────────────────

pub fn write_cell<W: Write>(w: &mut W, cell: &Cell) -> Result<(), CompactError> {
    write_u8(w, 2)?; // version 2: added children, parent, text_id
    write_str(w, &cell.label)?;
    write_str(w, &cell.region)?;
    write_str(w, &cell.claim.text)?;
    write_str(w, &cell.claim.source)?;
    write_string_vec(w, &cell.claim.evidence)?;
    write_f32(w, cell.claim.confidence)?;
    write_u64(w, cell.claim.last_verified)?;
    write_u64(w, cell.claim.created_at)?;
    write_string_vec(w, &cell.claim.contradictions)?;
    write_sparsevec(w, &cell.claim.vec)?;
    write_f32(w, cell.claim.vitality)?;
    write_u8(w, cell.claim.layer)?;
    write_str(w, &cell.claim.user_id)?;
    write_str(w, &cell.claim.channel_id)?;
    write_str(w, &cell.claim.message_id)?;
    write_str(w, &cell.claim.guild_id)?;
    write_string_vec(w, &cell.claim.keywords)?;
    let has_cont = cell.continuation.is_some();
    write_u8(w, if has_cont { 1 } else { 0 })?;
    if has_cont {
        write_sparsevec(w, cell.continuation.as_ref().unwrap())?;
    }
    write_u64(w, cell.last_fired)?;
    write_f32(w, cell.convergence_score)?;
    write_u32(w, cell.nnz)?;
    write_sparsevec(w, &cell.pos_vec)?;
    write_u32_vec(w, &cell.children)?;
    write_u8(w, if cell.parent.is_some() { 1 } else { 0 })?;
    if let Some(p) = cell.parent {
        write_u32(w, p)?;
    }
    write_u32(w, cell.text_id)?;
    Ok(())
}

pub fn read_cell<R: Read>(r: &mut R) -> Result<Cell, CompactError> {
    let ver = read_u8(r)?;
    if ver != 1 && ver != 2 { return Err(CompactError::Corrupt("unknown cell version")); }
    let label = read_str(r)?;
    let region = read_str(r)?;
    let text = read_str(r)?;
    let source = read_str(r)?;
    let evidence = read_string_vec(r)?;
    let confidence = read_f32(r)?;
    let last_verified = read_u64(r)?;
    let created_at = read_u64(r)?;
    let contradictions = read_string_vec(r)?;
    let vec = read_sparsevec(r)?;
    let vitality = read_f32(r)?;
    let layer = read_u8(r)?;
    let user_id = read_str(r)?;
    let channel_id = read_str(r)?;
    let message_id = read_str(r)?;
    let guild_id = read_str(r)?;
    let keywords = read_string_vec(r)?;
    let claim = Claim { text, source: Arc::from(source), evidence, confidence, last_verified, created_at, contradictions, vec, vitality, layer, user_id: Arc::from(user_id), channel_id: Arc::from(channel_id), message_id: Arc::from(message_id), guild_id: Arc::from(guild_id), keywords };
    let has_cont = read_u8(r)?;
    let continuation = if has_cont == 1 { Some(read_sparsevec(r)?) } else { None };
    let last_fired = read_u64(r)?;
    let convergence_score = read_f32(r)?;
    let nnz = read_u32(r)?;
    let pos_vec = read_sparsevec(r)?;
    let (children, parent, text_id) = if ver >= 2 {
        let children = read_u32_vec(r)?;
        let has_parent = read_u8(r)?;
        let parent = if has_parent == 1 { Some(read_u32(r)?) } else { None };
        let text_id = read_u32(r)?;
        (children, parent, text_id)
    } else {
        (Vec::new(), None, 0)
    };
    let resonance_signature = crate::core::universe::compute_resonance_signature(claim.layer, &claim.user_id, &claim.source, &region);
    Ok(Cell { label, region: Arc::from(region), claim, continuation, last_fired, convergence_score, nnz, pos_vec, children, parent, text_id, is_archived: false, activation_heat: 0.0, resonance_signature })
}

// ── Compression ─────────────────────────────────────────────────────────────

pub fn compress(data: &[u8]) -> Result<Vec<u8>, CompactError> {
    let mut enc = zstd::stream::write::Encoder::new(Vec::new(), 3)?;
    enc.write_all(data)?;
    Ok(enc.finish()?)
}

pub fn decompress(data: &[u8]) -> Result<Vec<u8>, CompactError> {
    let mut dec = zstd::stream::read::Decoder::new(data)?;
    let mut out = Vec::new();
    // TRUNCATION-TOLERANT: an interrupted/killed save can leave a zstd stream with a
    // cut tail ("premature end"). read_to_end would error and lose the WHOLE brain.
    // Instead read in chunks and keep everything that decompressed cleanly, stopping
    // at the first error — so a partial save still yields a partial (recoverable) brain.
    let mut buf = vec![0u8; 1 << 20];
    loop {
        match dec.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(e) => {
                eprintln!("[persistence] decompress hit a truncated stream ({}); recovered {} bytes.", e, out.len());
                break;
            }
        }
    }
    Ok(out)
}

// ── Batch I/O ─────────────────────────────────────────────────────────────────

/// Serializes a slice of `Cell` objects into a tightly packed, Zstandard-compressed binary vector.
///
/// This function acts as the primary persistence layer for KAI's neural lattice. It first
/// encodes the total number of cells, then iteratively encodes each `Cell` using a custom
/// sparse vector format, achieving ~7x reduction compared to JSON before passing the raw
/// buffer to Zstandard for an additional ~3-5x compression.
///
/// # Arguments
/// * `cells` - A slice of cells representing a geometric region of the KAI memory lattice.
///
/// # Returns
/// A `Result` containing the compressed byte vector on success, or a `CompactError` on failure.
pub fn serialize_cells(cells: &[Cell]) -> Result<Vec<u8>, CompactError> {
    let mut raw = Vec::new();
    raw.extend_from_slice(&(cells.len() as u32).to_le_bytes());
    for cell in cells { write_cell(&mut raw, cell)?; }
    compress(&raw)
}

#[inline(never)]
/// Deserializes a Zstandard-compressed byte slice back into a vector of `Cell` objects.
///
/// This reads the header length and sequentially decodes the tightly packed sparse vectors.
/// It contains explicit bounds checking to prevent out-of-memory allocations in the event
/// of a corrupted payload.
///
/// # Arguments
/// * `data` - A byte slice containing the compressed output from `serialize_cells`.
///
/// # Returns
/// A `Result` containing the reconstructed `Vec<Cell>` on success, or a `CompactError` on failure.
pub fn deserialize_cells(data: &[u8]) -> Result<Vec<Cell>, CompactError> {
    let raw = decompress(data)?;
    let mut r = &raw[..];
    let mut cb = [0u8; 4];
    r.read_exact(&mut cb)?;
    let n = u32::from_le_bytes(cb) as usize;
    if n > 10_000_000 { return Err(CompactError::Corrupt("cell count too high")); }
    let mut cells = Vec::with_capacity(n.min(100_000));
    for _ in 0..n { cells.push(read_cell(&mut r)?); }
    Ok(cells)
}

// ── Validation & Repair ─────────────────────────────────────────────────────

pub fn validate_cell(cell: &Cell) -> bool {
    let actual = cell.claim.vec.nnz() as u32;
    if cell.nnz != 0 && cell.nnz != actual { return false; }
    if !(cell.claim.confidence >= 0.0 && cell.claim.confidence <= 10.0) { return false; }
    if !(cell.convergence_score >= 1.0 && cell.convergence_score <= 10.0) { return false; }
    if cell.claim.text.len() > 100_000 { return false; }
    true
}

pub fn repair_cell(cell: &mut Cell) {
    cell.claim.vec = SparseVec::encode(&cell.claim.text);
    cell.nnz = cell.claim.vec.nnz() as u32;
    let phi_g = cell.claim.confidence.clamp(0.0, 1.0) * 0.5;
    let angles = [phi_g, 0.5_f32, 0.0_f32, 0.3_f32, 0.5_f32];
    let mean = angles.iter().sum::<f32>() / 5.0;
    let variance = angles.iter().map(|a| (a - mean).powi(2)).sum::<f32>() / 5.0;
    let std_dev = variance.sqrt();
    cell.convergence_score = if std_dev < 0.001 { 1.001_f32 } else { (1.0_f32 / std_dev).min(9.99) };
    if cell.continuation.as_ref().map_or(0, |c| c.nnz()) > DIM { cell.continuation = None; }
    if cell.pos_vec.nnz() > DIM { cell.pos_vec = SparseVec::zero(); }
}

pub fn serialize_synapses(synapses: &[crate::core::synapse::Synapse]) -> Result<Vec<u8>, CompactError> {
    let mut raw = Vec::new();
    let mut label_table = Vec::new();
    let mut label_to_idx = std::collections::HashMap::new();

    let mut get_or_insert = |label: &Arc<str>| -> u32 {
        *label_to_idx.entry(label.clone()).or_insert_with(|| {
            let idx = label_table.len() as u32;
            label_table.push(label.to_string());
            idx
        })
    };

    let mut interned = Vec::with_capacity(synapses.len());
    for s in synapses {
        let p = get_or_insert(&s.pre_label);
        let q = get_or_insert(&s.post_label);
        interned.push((p, q, s.weight, s.last_fire_tick, s.fire_count));
    }

    raw.extend_from_slice(&(label_table.len() as u32).to_le_bytes());
    for label in &label_table {
        let bytes = label.as_bytes();
        raw.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        raw.extend_from_slice(bytes);
    }

    raw.extend_from_slice(&(synapses.len() as u32).to_le_bytes());
    for (p, q, w, t, c) in interned {
        raw.extend_from_slice(&p.to_le_bytes());
        raw.extend_from_slice(&q.to_le_bytes());
        raw.extend_from_slice(&w.to_le_bytes());
        raw.extend_from_slice(&(t as u32).to_le_bytes());
        raw.extend_from_slice(&(c as u32).to_le_bytes());
    }

    compress(&raw)
}

pub fn deserialize_synapses(data: &[u8]) -> Result<crate::core::SynapticLayer, CompactError> {
    let raw = decompress(data)?;
    let mut r = &raw[..];
    let mut buf4 = [0u8; 4];

    r.read_exact(&mut buf4)?;
    let label_count = u32::from_le_bytes(buf4) as usize;
    if label_count > 10_000_000 {
        return Err(CompactError::Corrupt("label table too large"));
    }

    let mut label_table = Vec::with_capacity(label_count);
    for _ in 0..label_count {
        r.read_exact(&mut buf4)?;
        let len = u32::from_le_bytes(buf4) as usize;
        if len > 100_000 {
            return Err(CompactError::Corrupt("label string too long"));
        }
        let mut buf = vec![0u8; len];
        r.read_exact(&mut buf)?;
        let s = String::from_utf8(buf).map_err(|_| CompactError::Corrupt("invalid UTF-8"))?;
        label_table.push(s);
    }

    r.read_exact(&mut buf4)?;
    let synapse_count = u32::from_le_bytes(buf4) as usize;
    if synapse_count > 50_000_000 {
        return Err(CompactError::Corrupt("synapse count too high"));
    }

    let mut synapses = Vec::with_capacity(synapse_count);
    let mut buf20 = [0u8; 20];
    for _ in 0..synapse_count {
        // TRUNCATION-TOLERANT: if the (possibly cut-off) stream runs out mid-array,
        // keep every synapse we DID read instead of throwing away the whole brain.
        if r.read_exact(&mut buf20).is_err() {
            eprintln!("[persistence] synapse stream ended early — recovered {} of {} declared synapses.", synapses.len(), synapse_count);
            break;
        }
        let p = u32::from_le_bytes(buf20[0..4].try_into().unwrap()) as usize;
        let q = u32::from_le_bytes(buf20[4..8].try_into().unwrap()) as usize;
        let w = f32::from_le_bytes(buf20[8..12].try_into().unwrap());
        let t = u32::from_le_bytes(buf20[12..16].try_into().unwrap()) as u64;
        let c = u32::from_le_bytes(buf20[16..20].try_into().unwrap()) as u64;

        let pre_label: Arc<str> = label_table.get(p).map(|s| s.as_str()).unwrap_or("").into();
        let post_label: Arc<str> = label_table.get(q).map(|s| s.as_str()).unwrap_or("").into();

        synapses.push(crate::core::synapse::Synapse {
            pre_label,
            post_label,
            weight: w,
            last_fire_tick: t,
            fire_count: c,
        });
    }

    let mut index: std::collections::HashMap<Arc<str>, Vec<usize>> = std::collections::HashMap::new();
    for (idx, syn) in synapses.iter().enumerate() {
        index.entry(syn.pre_label.clone()).or_default().push(idx);
    }

    Ok(crate::core::SynapticLayer {
        synapses,
        index,
        latent_traces: std::collections::HashSet::new(),
        tick: 0,
        total_ltp: 0,
        total_ltd: 0,
        total_pruned: 0,
        surprise_level: 0.0,
        // Came off disk -> arm the one-time idle-clock rebase.
        loaded_from_disk: true,
    })
}

