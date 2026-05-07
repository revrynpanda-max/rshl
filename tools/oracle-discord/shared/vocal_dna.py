import sys
import os
import numpy as np
import librosa
import scipy.spatial.distance as dist
import json

def extract_mfcc(audio_path):
    """Extracts the Mel-Frequency Cepstral Coefficients (Vocal DNA)"""
    try:
        # Load audio (downsample to 16k for consistency)
        y, sr = librosa.load(audio_path, sr=16000)
        # Trim silence
        y, _ = librosa.effects.trim(y)
        # Extract MFCCs
        mfccs = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=20)
        # Calculate mean to get a fixed-size signature
        signature = np.mean(mfccs.T, axis=0)
        return signature
    except Exception as e:
        print(f"ERROR: {e}")
        return None

def enroll(audio_path, output_dna_path):
    signature = extract_mfcc(audio_path)
    if signature is not None:
        np.save(output_dna_path, signature)
        print(f"SUCCESS: DNA Signature anchored to {output_dna_path}")
    else:
        print("FAILURE: Could not extract DNA.")

def verify(audio_path, reference_dna_path):
    if not os.path.exists(reference_dna_path):
        print("ERROR: Reference DNA not found.")
        return

    current_sig = extract_mfcc(audio_path)
    ref_sig = np.load(reference_dna_path)

    if current_sig is not None:
        # Calculate Cosine Similarity (1.0 = perfect match)
        similarity = 1 - dist.cosine(current_sig, ref_sig)
        print(f"SIMILARITY: {similarity:.4f}")
    else:
        print("ERROR: Verification failed.")

if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "--enroll":
        enroll(sys.argv[2], sys.argv[3])
    elif mode == "--verify":
        verify(sys.argv[2], sys.argv[3])
