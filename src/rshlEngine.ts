"use strict";

/**
 * rshlEngine.ts — RSHL Geometric Response Engine
 *
 * This replaces QueryEngine.ts. No KAI API. No LLM.
 * All responses come from the sparse ternary geometric field.
 *
 * How it works:
 *   1. User message → resonance search across all 4 regions
 *   2. Top hits + query vector → bundleVectors() → synthetic thought vector
 *   3. cleanup() pulls the synthetic vector toward the nearest real cell
 *   4. computeFieldState() evaluates phi_g, C, chi, confidence
 *   5. Response is formatted from the strongest geometric match
 *
 * The UI (React/Ink) expects a streaming interface. We simulate word-by-word
 * streaming so all existing UI components work without modification.
 *
 * Drop-in replacement path:
 *   - RSHLEngine.query()        replaces QueryEngine.submitMessage()
 *   - RSHLEngine.streamQuery()  replaces QueryEngine streaming path
 *   - RSHLEngine.fieldStatus()  new — exposes live field metrics to UI
 */

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { logForDebugging } from './utils/debug.js'
import { initKAISubstrate, runDreamCycle, isSubstrateInitialized } from './services/kaiSubstrate.js'

const _require = createRequire(import.meta.url)
const _rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')

function _r(name: string): any {
  return _require(join(_rootDir, name))
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type RSHLHit = {
  text: string
  region: string
  score: number
}

export type RSHLFieldMetrics = {
  phi_g: number   // goal-aligned emergence (0-1)
  C: number       // commit readiness
  Wm: number      // memory write gate
  chi: number     // contradiction pressure
  tau: number     // temporal recurrence
  R: number       // raw resonance
}

export type RSHLResponse = {
  text: string              // The geometric response
  thought: string           // Generative synthesis result
  confidence: number        // 0-1 geometric confidence
  primaryRegion: string     // Region that answered strongest
  resonanceHits: RSHLHit[]  // Top resonant cells
  sources: RSHLHit[]        // Sources that contributed to synthesis
  field: RSHLFieldMetrics   // Live field metrics at response time
  noResonance: boolean      // True if field had nothing to say
}

// ── Engine class ──────────────────────────────────────────────────────────────

export class RSHLEngine {
  private universe: any = null
  private generateToResult: any = null
  private computeFieldState: any = null
  private makeWinnerKey: any = null
  private clamp01: any = null
  private textVec: any = null
  private ready = false

  private readonly GOAL_TEXT =
    'coherent world understanding with low contradiction and natural intelligence growth'

  private readonly SILENCE_THRESHOLD = 0.38  // Below this: no strong resonance

  constructor() {
    this.init()
  }

  private init(): void {
    try {
      // Ensure the cognitive substrate is booted (idempotent)
      initKAISubstrate()

      this.universe        = _r('universe')
      this.generateToResult = _r('generative-core').generateToResult
      this.computeFieldState = _r('field-state').computeFieldState
      this.makeWinnerKey   = _r('field-state').makeWinnerKey
      this.clamp01         = _r('field-state').clamp01
      this.textVec         = _r('rshl-core').textVec

      this.ready = true
      logForDebugging(`[RSHLEngine] Ready — ${this.universe.count()} cells in field`)
    } catch (err: unknown) {
      logForDebugging(`[RSHLEngine] Init failed: ${(err as Error).message}`)
    }
  }

  // ── Core query ─────────────────────────────────────────────────────────────

  query(input: string): RSHLResponse {
    if (!this.ready) {
      return this._silence(input, 'engine not ready')
    }

    const trimmed = input.trim()
    if (!trimmed) {
      return this._silence(input, 'empty input')
    }

    // 1. Resonance search — what does the field know?
    const hits: RSHLHit[] = this.universe.query(trimmed, 5).map((h: any) => ({
      text: h.text,
      region: h.region,
      score: h.score,
    }))

    // 2. Generative synthesis — bundle + cleanup → thought
    const synthesis = this.generateToResult(trimmed, 5)
    const thought: string  = synthesis.thought
    const confidence: number = synthesis.confidence
    const sources: RSHLHit[] = (synthesis.matches || []).map((m: any) => ({
      text: m.text,
      region: m.region,
      score: m.score,
    }))

    // 3. Field state
    const best = hits[0]
    const field = this._fieldMetrics(synthesis, hits)

    // 4. Silence check — if nothing resonates, say nothing
    const noResonance =
      !best ||
      best.score < this.SILENCE_THRESHOLD ||
      thought === 'no strong concept found'

    if (noResonance) {
      return this._silence(input, 'below resonance threshold')
    }

    // 5. Build response — use best resonance hit OR thought if synthesis is stronger
    const responseText =
      confidence > (best?.score ?? 0) && thought !== 'no strong concept found'
        ? thought
        : best?.text ?? thought

    return {
      text: responseText,
      thought,
      confidence,
      primaryRegion: best?.region ?? 'memory',
      resonanceHits: hits,
      sources,
      field,
      noResonance: false,
    }
  }

  // ── Streaming interface (word-by-word for UI compatibility) ────────────────

  async *streamQuery(input: string): AsyncGenerator<string, RSHLResponse, void> {
    const response = this.query(input)

    if (response.noResonance) {
      yield '...'
      yield ' (No strong resonance)'
      return response
    }

    // Emit field region tag
    yield `[${response.primaryRegion}] `

    // Stream the response text word by word
    const words = response.text.split(' ')
    for (const word of words) {
      yield word + ' '
      // ~40ms per word ≈ natural reading pace without feeling slow
      await new Promise(r => setTimeout(r, 40))
    }

    return response
  }

  // ── Field status ───────────────────────────────────────────────────────────

  fieldStatus(): {
    cells: number
    regions: Record<string, number>
    candidates: number
    avgStrength: number
    engine: string
    dreamCycleAvailable: boolean
  } {
    if (!this.ready) {
      return { cells: 0, regions: {}, candidates: 0, avgStrength: 0, engine: 'not ready', dreamCycleAvailable: false }
    }

    const cells = this.universe.getCells()
    const regions: Record<string, number> = {}
    cells.forEach((c: any) => { regions[c.region] = (regions[c.region] || 0) + 1 })
    const avgStrength = cells.length
      ? cells.reduce((s: number, c: any) => s + c.strength, 0) / cells.length
      : 0

    const info = this.universe.engineInfo()

    return {
      cells: cells.length,
      regions,
      candidates: 0, // filled by caller who has candidateBuffer access
      avgStrength: Math.round(avgStrength * 1000) / 1000,
      engine: info.native ? `native v${info.native}` : 'JS',
      dreamCycleAvailable: isSubstrateInitialized(),
    }
  }

  // ── Store a memory directly ────────────────────────────────────────────────

  store(text: string, region: string = 'memory', meta: Record<string, unknown> = {}): void {
    if (!this.ready) return
    this.universe.store(text, region, meta)
  }

  // ── Is the engine ready? ──────────────────────────────────────────────────

  isReady(): boolean {
    return this.ready
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _fieldMetrics(synthesis: any, hits: RSHLHit[]): RSHLFieldMetrics {
    try {
      const { textVec } = _r('rshl-core')
      const goalVec = textVec(this.GOAL_TEXT)
      const synthVec = synthesis.synthetic || []

      const field = this.computeFieldState({
        syntheticVec:    synthVec,
        sourceCells:     hits.slice(0, 3).map((h: RSHLHit) => ({
          text: h.text,
          region: h.region,
          meta: {},
        })),
        candidateScores: hits.slice(0, 3).map((h: RSHLHit) => h.score),
        goalText:        this.GOAL_TEXT,
        winnerKey:       this.makeWinnerKey([synthesis.thought || '']),
        history:         [],
        totalCount:      this.universe.count(),
      })

      return {
        phi_g: field.phi_g ?? 0,
        C:     field.C ?? 0,
        Wm:    field.Wm ?? 0,
        chi:   field.chi ?? 0,
        tau:   field.tau ?? 0,
        R:     field.R ?? 0,
      }
    } catch {
      return { phi_g: 0, C: 0, Wm: 0, chi: 0, tau: 0, R: 0 }
    }
  }

  private _silence(input: string, reason: string): RSHLResponse {
    logForDebugging(`[RSHLEngine] Silent (${reason}) for: "${input.slice(0, 40)}"`)
    return {
      text: '...',
      thought: 'no strong concept found',
      confidence: 0,
      primaryRegion: 'none',
      resonanceHits: [],
      sources: [],
      field: { phi_g: 0, C: 0, Wm: 0, chi: 0, tau: 0, R: 0 },
      noResonance: true,
    }
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────
// Import this anywhere in src/ instead of QueryEngine

let _engine: RSHLEngine | null = null

export function getRSHLEngine(): RSHLEngine {
  if (!_engine) {
    _engine = new RSHLEngine()
  }
  return _engine
}
