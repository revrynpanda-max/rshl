/*
 * RSHL GPU Throughput Benchmark
 * Measures cuBLAS SGEMM batch query throughput on the installed GPU.
 * Simulates the exact RSHL workload: N entries × D dimensions, ternary values.
 *
 * Compile (run build.bat, or manually):
 *   nvcc -O2 -arch=sm_89 rshl_cuda_bench.cu -lcublas -o rshl_cuda_bench.exe
 *
 * Output: JSON to stdout.
 */

#include <cuda_runtime.h>
#include <cublas_v2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* RSHL parameters — match the JS bench exactly */
#define N_ENTRIES 25000
#define DIM       4096

#define CK(x) do { \
    cudaError_t _e = (x); \
    if (_e != cudaSuccess) { \
        fprintf(stderr, "CUDA error at %s:%d — %s\n", __FILE__, __LINE__, \
                cudaGetErrorString(_e)); \
        exit(1); \
    } \
} while (0)

#define BK(x) do { \
    cublasStatus_t _s = (x); \
    if (_s != CUBLAS_STATUS_SUCCESS) { \
        fprintf(stderr, "cuBLAS error at %s:%d — status %d\n", __FILE__, __LINE__, (int)_s); \
        exit(1); \
    } \
} while (0)

/* Fast inline LCG — avoids rand() call overhead for 100M fills */
static unsigned int lcg_next(unsigned int *state) {
    *state = *state * 1664525u + 1013904223u;
    return *state;
}

static void fill_ternary_f32(float *p, size_t n, unsigned int seed) {
    /* ~5% density, equal -1/+1 split — matches RSHL ACTIVE ratio */
    for (size_t i = 0; i < n; i++) {
        unsigned int r = lcg_next(&seed) % 100u;
        p[i] = (r < 3u) ? -1.0f : (r < 6u) ? 1.0f : 0.0f;
    }
}

int main(void) {
    /* ── Device info ─────────────────────────────────────────────── */
    int dev = 0;
    cudaDeviceProp prop;
    CK(cudaGetDeviceProperties(&prop, dev));

    /* ── Host matrix: N_ENTRIES × DIM float32 ────────────────────── */
    size_t mat_bytes = (size_t)N_ENTRIES * DIM * sizeof(float);   /* ~400 MB */
    float *h_mat = (float *)malloc(mat_bytes);
    if (!h_mat) {
        fprintf(stderr, "OOM: need %zu MB on host\n", mat_bytes / (1024*1024));
        return 1;
    }
    fill_ternary_f32(h_mat, (size_t)N_ENTRIES * DIM, 42u);

    /* ── Device buffers ───────────────────────────────────────────── */
    float *d_mat = NULL, *d_q = NULL, *d_s = NULL;
    CK(cudaMalloc(&d_mat, mat_bytes));
    CK(cudaMemcpy(d_mat, h_mat, mat_bytes, cudaMemcpyHostToDevice));
    free(h_mat);   /* not needed on host any more */

    /* Query batch buffer: DIM × 1000 (for max batch run) */
    int MAX_BATCH = 1000;
    size_t q_bytes = (size_t)DIM * MAX_BATCH * sizeof(float);
    CK(cudaMalloc(&d_q, q_bytes));
    CK(cudaMalloc(&d_s, (size_t)N_ENTRIES * MAX_BATCH * sizeof(float)));

    float *h_q = (float *)malloc(q_bytes);
    fill_ternary_f32(h_q, (size_t)DIM * MAX_BATCH, 99u);
    CK(cudaMemcpy(d_q, h_q, q_bytes, cudaMemcpyHostToDevice));
    free(h_q);

    /* ── cuBLAS setup ─────────────────────────────────────────────── */
    cublasHandle_t handle;
    BK(cublasCreate(&handle));

    cudaEvent_t ev0, ev1;
    CK(cudaEventCreate(&ev0));
    CK(cudaEventCreate(&ev1));

    float alpha = 1.0f, beta = 0.0f;

    /*
     * SGEMM call convention:
     *   C[N×B] = M[N×D] × Q[D×B]
     *
     * Our matrix d_mat is row-major [N×D].
     * cuBLAS is col-major; passing it as-is makes cuBLAS see M^T[D×N].
     * With CUBLAS_OP_T on A we transpose back: op(A) = M[N×D]. ✓
     *
     *   cublasSgemm(N×1, 1×B, D:
     *     transa=T, transb=N,
     *     m=N, n=B, k=D,
     *     A=d_mat lda=D,   (M^T col-major [D×N])
     *     B=d_q   ldb=D,   (Q   col-major [D×B])
     *     C=d_s   ldc=N    (S   col-major [N×B])
     */
#define SGEMM(B) \
    BK(cublasSgemm(handle, CUBLAS_OP_T, CUBLAS_OP_N, \
        N_ENTRIES, (B), DIM, &alpha, \
        d_mat, DIM, d_q, DIM, &beta, d_s, N_ENTRIES))

    /* Warm up: 5 passes at batch=1 so CUDA JIT is done before timing */
    for (int i = 0; i < 5; i++) { SGEMM(1); }
    CK(cudaDeviceSynchronize());

    /* ── Single-query bandwidth measurement (batch = 1) ──────────── */
    int bw_iters = 300;
    CK(cudaEventRecord(ev0));
    for (int i = 0; i < bw_iters; i++) { SGEMM(1); }
    CK(cudaEventRecord(ev1));
    CK(cudaEventSynchronize(ev1));
    float bw_ms = 0.0f;
    CK(cudaEventElapsedTime(&bw_ms, ev0, ev1));

    double sq_per_sec   = bw_iters / (bw_ms / 1000.0);
    double mat_gb       = (double)mat_bytes / 1e9;
    double bandwidth_gbps = mat_gb * sq_per_sec;

    /* ── Batch throughput sweep ───────────────────────────────────── */
    int   batches[4] = {1, 10, 100, 1000};
    double b_qps[4], b_ips[4];

    for (int bi = 0; bi < 4; bi++) {
        int B     = batches[bi];
        int iters = (B <=  10) ? 500 :
                    (B <= 100) ? 200 : 60;

        /* warmup */
        for (int i = 0; i < 3; i++) { SGEMM(B); }
        CK(cudaDeviceSynchronize());

        CK(cudaEventRecord(ev0));
        for (int i = 0; i < iters; i++) { SGEMM(B); }
        CK(cudaEventRecord(ev1));
        CK(cudaEventSynchronize(ev1));
        float ms = 0.0f;
        CK(cudaEventElapsedTime(&ms, ev0, ev1));

        b_qps[bi] = (double)B * iters / (ms / 1000.0);
        b_ips[bi] = b_qps[bi] * N_ENTRIES;
    }
#undef SGEMM

    /* ── Print JSON ───────────────────────────────────────────────── */
    printf("{\n");
    printf("  \"device\": \"%s\",\n", prop.name);
    printf("  \"vram_mb\": %llu,\n",
           (unsigned long long)(prop.totalGlobalMem / (1024*1024)));
    printf("  \"bandwidth_gbps\": %.1f,\n", bandwidth_gbps);
    printf("  \"matrix_mb\": %.0f,\n", (double)mat_bytes / 1e6);
    printf("  \"entries\": %d,\n", N_ENTRIES);
    printf("  \"dims\": %d,\n", DIM);
    printf("  \"batch_results\": [\n");
    for (int bi = 0; bi < 4; bi++) {
        printf("    {\"batch\": %d, \"qps\": %.0f, \"items_per_sec\": %.0f}%s\n",
               batches[bi], b_qps[bi], b_ips[bi],
               bi < 3 ? "," : "");
    }
    printf("  ],\n");
    printf("  \"peak_items_per_sec\": %.0f,\n", b_ips[3]);
    printf("  \"peak_tflops\": %.3f\n",
           b_ips[3] * 2.0 / 1e12);
    printf("}\n");

    /* ── Cleanup ──────────────────────────────────────────────────── */
    cudaEventDestroy(ev0);
    cudaEventDestroy(ev1);
    cublasDestroy(handle);
    cudaFree(d_mat);
    cudaFree(d_q);
    cudaFree(d_s);

    return 0;
}
