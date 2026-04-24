"use strict";

/**
 * kaiSubstrate.ts — KAI Geometric Cognitive Substrate Bridge
 *
 * Bridges the TypeScript LLM runtime (src/) with the root-level geometric
 * cognitive layers (universe, rshl-lattice, candidate-buffer, promotion, etc.).
 *
 * The root JS files are CommonJS. We load them via createRequire, which gives
 * us a CJS-compatible require() from within the ESM TypeScript context.
 *
 * Integration points this module wires:
 *   1. Boots the cognitive field (seeds universe if not yet loaded)
 *   2. Creates and injects a Plasma instance into src/bootstrap/state.ts
 *      so getPlasma() returns a live field reference
 *   3. Exposes runDreamCycle() for the Heartbeat service to call
 *
 * Call initKAISubstrate() once at startup (e.g., from initHeartbeat()).
 * All subsequent calls are no-ops.
 */

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { setPlasma } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'

const _require = createRequire(import.meta.url)

// Root of the KAI project — two levels up from src/services/
const _rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function _r(relPath: string): any {
  return _require(join(_rootDir, relPath))
}

// ── Substrate state ──────────────────────────────────────────────────────────

let _plasma: any = null
let _consolidate: ((plasma: any, opts?: any) => any) | null = null
let _candidateBuffer: any = null
let _runPromotion: (() => any) | null = null
let _initialized = false

const GOAL_TEXT =
  'coherent world understanding with low contradiction and natural intelligence growth'

// ── Init ─────────────────────────────────────────────────────────────────────

/**
 * Boot the geometric cognitive substrate. Idempotent — safe to call multiple
 * times; only the first call does any work.
 *
 * On success, injects a live Plasma instance into the global TS state via
 * setPlasma() so that getPlasma() returns a usable reference in the Heartbeat
 * and any other service that needs field access.
 */
export function initKAISubstrate(): void {
  if (_initialized) return

  try {
    const persistence = _r('persistence')
    const universe    = _r('universe')

    // Load state from disk if available; otherwise seed fresh
    if (persistence.stateExists()) {
      const result = persistence.load()
      if (result.ok) {
        logForDebugging(
          `[KAISubstrate] Loaded ${result.cells} cells, ${result.candidates} candidates`,
        )
      } else {
        logForDebugging(
          `[KAISubstrate] Load failed (${result.error}), seeding fresh`,
        )
        _r('seed')
      }
    } else {
      logForDebugging('[KAISubstrate] No saved state — seeding fresh')
      _r('seed')
    }

    // Create a Plasma facade over universe (does NOT clear — substrate already loaded)
    const { Plasma } = _r('plasma')
    _plasma = new Plasma(false)

    // Wire field functions
    const lattice   = _r('rshl-lattice')
    _consolidate    = lattice.consolidate

    _candidateBuffer = _r('candidate-buffer')

    const promotion  = _r('promotion')
    _runPromotion    = promotion.runPromotion

    // Inject into global TS state so getPlasma() works in Heartbeat et al.
    setPlasma(_plasma)

    _initialized = true
    logForDebugging(
      `[KAISubstrate] Geometric substrate ready — ${universe.count()} cells in field`,
    )
  } catch (err: unknown) {
    logForDebugging(
      `[KAISubstrate] Init failed: ${(err as Error).message}`,
    )
  }
}

// ── Dream cycle ──────────────────────────────────────────────────────────────

export type DreamResult = {
  insight: string
  confidence: number
  resonance: number
  field: Record<string, number>
  promotionReady: boolean
  conceptA: string
  conceptB: string
}

/**
 * Run one geometric dream cycle:
 *   consolidate() → candidate observe → promotion check
 *
 * Returns null if no viable dream pair was found (too few cells or no
 * candidates in the resonance sweet-spot).
 */
export function runDreamCycle(): DreamResult | null {
  if (!_consolidate || !_plasma) return null

  try {
    const result = _consolidate(_plasma, { goalText: GOAL_TEXT })
    if (!result) return null

    if (_candidateBuffer) {
      _candidateBuffer.observe(result)
    }

    if (_runPromotion) {
      _runPromotion()
    }

    return result as DreamResult
  } catch (err: unknown) {
    logForDebugging(
      `[KAISubstrate] Dream cycle error: ${(err as Error).message}`,
    )
    return null
  }
}

// ── Accessors ────────────────────────────────────────────────────────────────

export function isSubstrateInitialized(): boolean {
  return _initialized
}

export function getSubstratePlasma(): any {
  return _plasma
}
