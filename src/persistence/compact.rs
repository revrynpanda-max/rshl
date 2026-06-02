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
    Ok(Cell { label, region: Arc::from(region), claim, continuation, last_fired, convergence_score, nnz, pos_vec, children, parent, text_id, is_archived: false, activation_heat: 0.0 })
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
    dec.read_to_end(&mut out)?;
    Ok(out)
}

// ── Batch I/O ─────────────────────────────────────────────────────────────────

pub fn serialize_cells(cells: &[Cell]) -> Result<Vec<u8>, CompactError> {
    let mut raw = Vec::new();
    raw.extend_from_slice(&(cells.len() as u32).to_le_bytes());
    for cell in cells { write_cell(&mut raw, cell)?; }
    compress(&raw)
}

#[inline(never)]
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
