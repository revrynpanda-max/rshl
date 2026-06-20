# KAI Fleet Stress / Chaos Report

- **Run:** 2026-06-19T21:09:41.997Z → 2026-06-19T21:11:27.625Z
- **Flags:** target=`all`, maxConcurrency=50, includeHeavy=true, includeWrites=true
- **Ramp steps:** 1 → 5 → 20 → 50 concurrent; payloads 200B → 100KB; breaking-point thresholds: errorRate>10% or p95>10000ms

## What to fix / reinforce (prioritized)

| # | Severity | Where | Function (file) | Issue |
|---|----------|-------|-----------------|-------|
| 1 | **MEDIUM** | Ollama (local model server) POST /api/generate | `Ollama /api/generate (shared/openjarvis.mjs, consolidate-memory.mjs:26)` | Degrades at concurrency=1, payload=200B (err=0%, p95=12771ms). Reinforce: backpressure / timeout / queue here. |
| 2 | **INFO** | KAI Engine (Rust CNS) | `C:\KAI\src\bridge\oracle_server.rs` | Service unreachable at run time (network-error). If it should be up, check the launcher / process. |
| 3 | **INFO** | OpenJarvis (cognitive core) | `external OpenJarvis service (:8080); callers in shared/openjarvis.mjs` | Service unreachable at run time (network-error). If it should be up, check the launcher / process. |
| 4 | **INFO** | Dashboard server | `C:\KAI\tools\oracle-discord\dashboard-server.mjs` | Service unreachable at run time (network-error). If it should be up, check the launcher / process. |

## KAI Engine (Rust CNS)  `http://127.0.0.1:3334`

**UNREACHABLE** — network-error. Skipped. Source: `C:\KAI\src\bridge\oracle_server.rs`

## OpenJarvis (cognitive core)  `http://127.0.0.1:8080`

**UNREACHABLE** — network-error. Skipped. Source: `external OpenJarvis service (:8080); callers in shared/openjarvis.mjs`

## Ollama (local model server)  `http://127.0.0.1:11434`

Source: `Ollama :11434 (callers: shared/openjarvis.mjs, consolidate-memory.mjs)`

### GET /api/tags
- Handler: `Ollama /api/tags (model list)`
- **Normal:** PASS — status 200, 13ms
- **Ramp:**

  | concurrency | payload | p50 | p95 | p99 | err% | 429% |
  |---|---|---|---|---|---|---|
  | 1 | 200B | 12ms | 16ms | 16ms | 0% | 0% |
  | 5 | 2000B | 17ms | 23ms | 26ms | 0% | 0% |
  | 20 | 20000B | 62ms | 100ms | 104ms | 0% | 0% |
  | 50 | 100000B | 84ms | 100ms | 100ms | 0% | 0% |

- **Breaking point:** none within ramp ceiling.

### GET /api/version
- Handler: `Ollama /api/version`
- **Normal:** PASS — status 200, 2ms
- **Ramp:**

  | concurrency | payload | p50 | p95 | p99 | err% | 429% |
  |---|---|---|---|---|---|---|
  | 1 | 200B | 0ms | 1ms | 2ms | 0% | 0% |
  | 5 | 2000B | 2ms | 3ms | 3ms | 0% | 0% |
  | 20 | 20000B | 5ms | 6ms | 6ms | 0% | 0% |
  | 50 | 100000B | 8ms | 10ms | 10ms | 0% | 0% |

- **Breaking point:** none within ramp ceiling.

### POST /api/generate
- Handler: `Ollama /api/generate (shared/openjarvis.mjs, consolidate-memory.mjs:26)`
- **Normal:** PASS — status 200, 12842ms
- **Ramp:**

  | concurrency | payload | p50 | p95 | p99 | err% | 429% |
  |---|---|---|---|---|---|---|
  | 1 | 200B | 8892ms | 12771ms | 12771ms | 0% | 0% |
  | 5 | 2000B | 19306ms | 30693ms | 30693ms | 0% | 0% |

- **Breaking point:** concurrency=1, payload=200B, err=0%, p95=12771ms
- **Chaos:** 11 probes, 0 hole(s).

## Dashboard server  `http://127.0.0.1:3001`

**UNREACHABLE** — network-error. Skipped. Source: `C:\KAI\tools\oracle-discord\dashboard-server.mjs`

---

### Failure-type legend
- `timeout` — no response within the endpoint timeout.
- `connection-refused` — nothing listening (service died / never up).
- `crash-suspect` — socket reset/hang-up mid-flight (possible handler panic / dropped connection).
- `server-5xx` — handler returned 500-class (unhandled internal error).
- `client-4xx` — 400-class; EXPECTED for chaos/malformed probes (graceful rejection).
- `rate-limited-429` — designed admission brake (e.g. QueryAdmission on /api/rshl/query). Healthy.
- `unexpected-response-shape` — 2xx but body did not match expected contract.
