import sys, os
import numpy as np
import librosa
import scipy.spatial.distance as dist

# ── VOCAL DNA v2 ────────────────────────────────────────────────────────────
# Richer voiceprint (MFCC mean+std+delta = ~60-dim, more discriminative than the
# old mean-only 20-dim), plus 1-to-many IDENTIFY and a LIVENESS/replay heuristic.

def signature(audio_path):
    """Speaker voiceprint: MFCC mean + std + delta-mean, L2-normalized (~60-dim)."""
    try:
        y, sr = librosa.load(audio_path, sr=16000)
        y, _ = librosa.effects.trim(y, top_db=25)
        if len(y) < sr * 0.3:           # need ~0.3s of real speech
            return None
        m = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=20)
        d = librosa.feature.delta(m)
        sig = np.concatenate([m.mean(axis=1), m.std(axis=1), d.mean(axis=1)])
        n = np.linalg.norm(sig)
        return sig / n if n > 0 else sig
    except Exception as e:
        print(f"ERROR: {e}")
        return None

def liveness(audio_path):
    """Heuristic 0..1 — higher = more likely a LIVE biological voice; lower = more
    likely a recording played through a speaker, or synthetic. NOT bulletproof
    (a high-fidelity replay can still score high) — pair with challenge-response."""
    try:
        y, sr = librosa.load(audio_path, sr=16000)
        y, _ = librosa.effects.trim(y, top_db=25)
        if len(y) < sr * 0.3:
            return 0.0
        S = np.abs(librosa.stft(y))
        freqs = librosa.fft_frequencies(sr=sr)
        hf = S[freqs > 3500].sum() / (S.sum() + 1e-9)        # phone-speaker replay rolls off highs
        rms = librosa.feature.rms(y=y)[0]
        dr = (rms.max() - rms.min()) / (rms.mean() + 1e-9)    # live speech is bursty; replay is flatter
        flat = float(np.mean(librosa.feature.spectral_flatness(y=y)))  # synthetic/looped = flatter
        zcr = float(np.mean(librosa.feature.zero_crossing_rate(y)))    # breath/fricative micro-detail
        score = (0.40 * min(hf / 0.18, 1.0)
                 + 0.30 * min(dr / 6.0, 1.0)
                 + 0.15 * (1.0 - min(flat / 0.5, 1.0))
                 + 0.15 * min(zcr / 0.12, 1.0))
        return float(max(0.0, min(1.0, score)))
    except Exception as e:
        print(f"ERROR: {e}")
        return 0.0

def _cos(a, b):
    n = min(len(a), len(b))     # tolerate old 20-dim signatures (graceful, re-enroll for full strength)
    return 1 - dist.cosine(a[:n], b[:n])

def enroll(audio_path, out_path):
    sig = signature(audio_path)
    if sig is not None:
        np.save(out_path, sig)
        print(f"SUCCESS: DNA Signature anchored to {out_path}")
    else:
        print("FAILURE: Could not extract DNA.")

def verify(audio_path, ref_path):
    if not os.path.exists(ref_path):
        print("ERROR: Reference DNA not found."); return
    cur = signature(audio_path)
    if cur is None:
        print("ERROR: Verification failed."); return
    ref = np.load(ref_path)
    print(f"SIMILARITY: {_cos(cur, ref):.4f} LIVENESS: {liveness(audio_path):.4f}")

def identify(audio_path, dna_dir):
    """1-to-many: who does this voice sound like? Recognizes you on ANY account."""
    cur = signature(audio_path)
    if cur is None:
        print("RESULT: none 0.0000 LIVENESS: 0.0000"); return
    best_name, best_sim = "none", -1.0
    second = -1.0
    if os.path.isdir(dna_dir):
        for f in os.listdir(dna_dir):
            if not f.endswith(".npy"): continue
            try:
                s = _cos(cur, np.load(os.path.join(dna_dir, f)))
            except Exception:
                continue
            if s > best_sim:
                second = best_sim; best_name, best_sim = f[:-4], s
            elif s > second:
                second = s
    margin = best_sim - (second if second > 0 else 0)   # confidence: gap to runner-up
    print(f"RESULT: {best_name} {best_sim:.4f} MARGIN: {margin:.4f} LIVENESS: {liveness(audio_path):.4f}")

if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "--enroll":
        enroll(sys.argv[2], sys.argv[3])
    elif mode == "--verify":
        verify(sys.argv[2], sys.argv[3])
    elif mode == "--identify":
        identify(sys.argv[2], sys.argv[3])
    elif mode == "--liveness":
        print(f"LIVENESS: {liveness(sys.argv[2]):.4f}")
