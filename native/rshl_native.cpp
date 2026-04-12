/**
 * rshl_native.cpp — AVX2 + OpenMP + Binary Ternary POPCNT native addon
 * Build: npx node-gyp configure build  (requires VS 2019/2022 or gcc/clang)
 *
 * Three query paths — fastest to slowest per memory footprint:
 *   batchQueryBinary      — Binary ternary format (1024 B/row). POPCNT.   ← NEW best path
 *   batchQuerySparseNoAlloc — Sparse format, pre-alloc result buffer.      ← previous best
 *   batchQuerySparse        — Sparse format, allocates result per call.
 *   batchQuery              — Dense int8 format, AVX2 multiply-accumulate.
 */
#include <napi.h>
#include <cstdint>
#include <cmath>
#include <cstring>
#ifdef _MSC_VER
#  include <intrin.h>
#  define POPCNT64(x) __popcnt64((unsigned __int64)(x))
#else
#  include <immintrin.h>
#  define POPCNT64(x) __builtin_popcountll((unsigned long long)(x))
#endif

#define HAS_AVX2 1
static const int DIM   = 4096;
static const int WORDS = DIM / 64;   // 64 uint64 words per mask

// ── AVX2 dense dot product ────────────────────────────────────────────────────
static int32_t dotScalar(const int8_t* __restrict r, const int8_t* __restrict q) {
  int32_t d = 0;
  for (int i = 0; i < DIM; i++) d += (int32_t)r[i] * (int32_t)q[i];
  return d;
}

#if HAS_AVX2
static int32_t dotAVX2(const int8_t* __restrict row, const int8_t* __restrict q) {
  __m256i acc = _mm256_setzero_si256();
  for (int d = 0; d < DIM; d += 32) {
    __m256i vr   = _mm256_loadu_si256((const __m256i*)(row + d));
    __m256i vq   = _mm256_loadu_si256((const __m256i*)(q   + d));
    __m256i prod = _mm256_sign_epi8(vr, vq);
    __m128i lo8  = _mm256_castsi256_si128(prod);
    __m128i hi8  = _mm256_extracti128_si256(prod, 1);
    __m256i lo16 = _mm256_cvtepi8_epi16(lo8);
    __m256i hi16 = _mm256_cvtepi8_epi16(hi8);
    acc = _mm256_add_epi32(acc, _mm256_add_epi32(
      _mm256_add_epi32(_mm256_cvtepi16_epi32(_mm256_castsi256_si128(lo16)),
                       _mm256_cvtepi16_epi32(_mm256_extracti128_si256(lo16,1))),
      _mm256_add_epi32(_mm256_cvtepi16_epi32(_mm256_castsi256_si128(hi16)),
                       _mm256_cvtepi16_epi32(_mm256_extracti128_si256(hi16,1)))));
  }
  __m128i lo  = _mm256_castsi256_si128(acc);
  __m128i hi  = _mm256_extracti128_si256(acc, 1);
  __m128i s   = _mm_add_epi32(lo, hi);
  s = _mm_hadd_epi32(s, s); s = _mm_hadd_epi32(s, s);
  return _mm_cvtsi128_si32(s);
}
#endif

static inline int32_t dot(const int8_t* r, const int8_t* q) {
#if HAS_AVX2
  return dotAVX2(r, q);
#else
  return dotScalar(r, q);
#endif
}

// ── Binary ternary dot product (POPCNT path) ──────────────────────────────────
// Row stored as [pos_mask: uint64[64], neg_mask: uint64[64]] = 1024 bytes.
// 4x less memory per row than int8 format → 4x less DRAM bandwidth → faster.
// Values: +1 = bit set in pos_mask, -1 = bit set in neg_mask, 0 = neither.
// dot(row, query) = popcount(rp&qp) + popcount(rn&qn) - popcount(rp&qn) - popcount(rn&qp)
static inline int32_t dotBinary(
    const uint64_t* __restrict rp, const uint64_t* __restrict rn,
    const uint64_t* __restrict qp, const uint64_t* __restrict qn)
{
  int32_t d = 0;
  for (int w = 0; w < WORDS; w++) {
    d += (int32_t)POPCNT64(rp[w] & qp[w]);   // +1 * +1 = +1
    d += (int32_t)POPCNT64(rn[w] & qn[w]);   // -1 * -1 = +1
    d -= (int32_t)POPCNT64(rp[w] & qn[w]);   // +1 * -1 = -1
    d -= (int32_t)POPCNT64(rn[w] & qp[w]);   // -1 * +1 = -1
  }
  return d;
}

// ── batchQuery (dense int8 + AVX2) ───────────────────────────────────────────
Napi::Value BatchQuery(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto mat   = info[0].As<Napi::Buffer<int8_t>>();
  auto nrm   = info[1].As<Napi::Buffer<float>>();
  int  n     = info[2].As<Napi::Number>().Int32Value();
  auto qbuf  = info[3].As<Napi::Buffer<int8_t>>();
  const int8_t* matrix = mat.Data();
  const float*  norms  = nrm.Data();
  const int8_t* qvec   = qbuf.Data();
  int qNnz = 0;
  for (int d = 0; d < DIM; d++) if (qvec[d] != 0) qNnz++;
  double qMag = std::sqrt((double)qNnz);
  auto result = Napi::Float64Array::New(env, n);
  double* scores = result.Data();
  if (qMag == 0.0 || n == 0) { std::memset(scores, 0, n * sizeof(double)); return result; }
  #ifdef _OPENMP
  #pragma omp parallel for schedule(dynamic,32)
  #endif
  for (int i = 0; i < n; i++) {
    int32_t d = dot(matrix + (size_t)i * DIM, qvec);
    double denom = (double)norms[i] * qMag;
    scores[i] = denom > 0.0 ? (double)d / denom : 0.0;
  }
  return result;
}

// ── batchQuerySparse (sparse int8, allocates result) ─────────────────────────
Napi::Value BatchQuerySparse(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto mat  = info[0].As<Napi::Buffer<int8_t>>();
  auto nrm  = info[1].As<Napi::Buffer<float>>();
  int  n    = info[2].As<Napi::Number>().Int32Value();
  auto idxA = info[3].As<Napi::Int32Array>();
  auto valA = info[4].As<Napi::Int8Array>();
  const int8_t*  matrix = mat.Data();
  const float*   norms  = nrm.Data();
  const int32_t* idxs   = idxA.Data();
  const int8_t*  vals   = valA.Data();
  int nActive = (int)idxA.ElementLength();
  double qMag = std::sqrt((double)nActive);
  auto result = Napi::Float64Array::New(env, n);
  double* scores = result.Data();
  if (qMag == 0.0 || n == 0) { std::memset(scores, 0, n*sizeof(double)); return result; }
  #ifdef _OPENMP
  #pragma omp parallel for schedule(dynamic,32)
  #endif
  for (int i = 0; i < n; i++) {
    const int8_t* row = matrix + (size_t)i * DIM;
    int32_t d = 0;
    for (int k = 0; k < nActive; k++) d += (int32_t)row[idxs[k]] * (int32_t)vals[k];
    double denom = (double)norms[i] * qMag;
    scores[i] = denom > 0.0 ? (double)d / denom : 0.0;
  }
  return result;
}

// ── batchQuerySparseNoAlloc (sparse int8, caller-supplied result buffer) ──────
Napi::Value BatchQuerySparseNoAlloc(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto mat  = info[0].As<Napi::Buffer<int8_t>>();
  auto nrm  = info[1].As<Napi::Buffer<float>>();
  int  n    = info[2].As<Napi::Number>().Int32Value();
  auto idxA = info[3].As<Napi::Int32Array>();
  auto valA = info[4].As<Napi::Int8Array>();
  auto outA = info[5].As<Napi::Float64Array>();
  const int8_t*  matrix = mat.Data();
  const float*   norms  = nrm.Data();
  const int32_t* idxs   = idxA.Data();
  const int8_t*  vals   = valA.Data();
  double*        scores = outA.Data();
  int nActive = (int)idxA.ElementLength();
  double qMag = std::sqrt((double)nActive);
  if (qMag == 0.0 || n == 0) { std::memset(scores, 0, n*sizeof(double)); return env.Undefined(); }
  #ifdef _OPENMP
  #pragma omp parallel for schedule(dynamic,32)
  #endif
  for (int i = 0; i < n; i++) {
    const int8_t* row = matrix + (size_t)i * DIM;
    int32_t d = 0;
    for (int k = 0; k < nActive; k++) d += (int32_t)row[idxs[k]] * (int32_t)vals[k];
    double denom = (double)norms[i] * qMag;
    scores[i] = denom > 0.0 ? (double)d / denom : 0.0;
  }
  return env.Undefined();
}

// ── batchQueryBinary (binary ternary + POPCNT, caller-supplied result) ────────
// args: matrix (Buffer), norms (Buffer<float>), n (int32),
//       qPos (Buffer — 512 bytes), qNeg (Buffer — 512 bytes),
//       outBuf (Float64Array — pre-allocated size n)
// Matrix layout: row i = [pos_mask: uint64[64] | neg_mask: uint64[64]] at offset i*1024
Napi::Value BatchQueryBinary(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto mat   = info[0].As<Napi::Buffer<uint8_t>>();
  auto nrm   = info[1].As<Napi::Buffer<float>>();
  int  n     = info[2].As<Napi::Number>().Int32Value();
  auto qpBuf = info[3].As<Napi::Buffer<uint8_t>>();
  auto qnBuf = info[4].As<Napi::Buffer<uint8_t>>();
  auto outA  = info[5].As<Napi::Float64Array>();

  const uint64_t* matrix = reinterpret_cast<const uint64_t*>(mat.Data());
  const float*    norms  = nrm.Data();
  const uint64_t* qp     = reinterpret_cast<const uint64_t*>(qpBuf.Data());
  const uint64_t* qn     = reinterpret_cast<const uint64_t*>(qnBuf.Data());
  double*         scores = outA.Data();

  // Query magnitude = sqrt(number of active dims in query)
  int qNnz = 0;
  for (int w = 0; w < WORDS; w++)
    qNnz += (int)(POPCNT64(qp[w]) + POPCNT64(qn[w]));
  double qMag = std::sqrt((double)qNnz);

  if (qMag == 0.0 || n == 0) { std::memset(scores, 0, n * sizeof(double)); return env.Undefined(); }

  #ifdef _OPENMP
  #pragma omp parallel for schedule(dynamic,32)
  #endif
  for (int i = 0; i < n; i++) {
    const uint64_t* rp = matrix + (size_t)i * WORDS * 2;
    const uint64_t* rn = rp + WORDS;
    int32_t d = dotBinary(rp, rn, qp, qn);
    double denom = (double)norms[i] * qMag;
    scores[i] = denom > 0.0 ? (double)d / denom : 0.0;
  }
  return env.Undefined();
}

Napi::Value Version(const Napi::CallbackInfo& info) {
  std::string v = "rshl-bench-native/1.1 avx2=";
#if HAS_AVX2
  v += "yes";
#else
  v += "no";
#endif
#ifdef _OPENMP
  v += " omp=yes";
#else
  v += " omp=no";
#endif
  v += " binary=yes";
  return Napi::String::New(info.Env(), v);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("batchQuery",             Napi::Function::New(env, BatchQuery));
  exports.Set("batchQuerySparse",       Napi::Function::New(env, BatchQuerySparse));
  exports.Set("batchQuerySparseNoAlloc",Napi::Function::New(env, BatchQuerySparseNoAlloc));
  exports.Set("batchQueryBinary",       Napi::Function::New(env, BatchQueryBinary));
  exports.Set("version",                Napi::Function::New(env, Version));
  return exports;
}
NODE_API_MODULE(rshl_native, Init)
