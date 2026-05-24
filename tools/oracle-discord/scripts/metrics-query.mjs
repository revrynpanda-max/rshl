#!/usr/bin/env node
// scripts/metrics-query.mjs
// CLI inspector for the unified metrics store.
//
// USAGE
//   node scripts/metrics-query.mjs [--source S] [--metric M] [--since 5m]
//                                   [--until 1m] [--limit 50] [--tag k=v]
//                                   [--agg]   [--latest]   [--sources] [--metrics]
//
// EXAMPLES
//   List the last 20 records, any source/metric:
//     node scripts/metrics-query.mjs --limit 20
//
//   CPU% over the last 10 minutes:
//     node scripts/metrics-query.mjs --source performance-monitor --metric cpu_pct --since 10m
//
//   Average / min / max of Groq's TTS latency in the last hour:
//     node scripts/metrics-query.mjs --source tts-engine --metric tts_latency_ms --tag bot=Groq --since 1h --agg
//
//   What's the most recent GPU sample?
//     node scripts/metrics-query.mjs --source performance-monitor --metric gpu_pct --latest
//
//   List all known sources / metrics for a source:
//     node scripts/metrics-query.mjs --sources
//     node scripts/metrics-query.mjs --metrics --source performance-monitor

import { queryMetrics, latestMetric, aggregateMetric } from '../shared/metrics-store.mjs';

// ── tiny arg parser ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = { tags: {} };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = args[i + 1];
  switch (a) {
    case '--source':  opts.source = next; i++; break;
    case '--metric':  opts.metric = next; i++; break;
    case '--since':   opts.since  = parseWindow(next); i++; break;
    case '--until':   opts.until  = parseWindow(next); i++; break;
    case '--limit':   opts.limit  = parseInt(next, 10); i++; break;
    case '--tag': {
      const [k, v] = (next || '').split('=');
      if (k && v !== undefined) opts.tags[k] = v;
      i++; break;
    }
    case '--agg':     opts.agg = true; break;
    case '--latest':  opts.latest = true; break;
    case '--sources': opts.listSources = true; break;
    case '--metrics': opts.listMetrics = true; break;
    case '--help':
    case '-h':
      printHelp(); process.exit(0);
    default:
      console.error(`unknown arg: ${a}`);
      printHelp(); process.exit(1);
  }
}

function parseWindow(s) {
  // Accepts "10m", "1h", "30s", "1d", or raw ms. Returns epoch ms in the past.
  if (!s) return null;
  const m = String(s).match(/^(\d+)\s*([smhd])?$/);
  if (!m) return parseInt(s, 10);
  const n = parseInt(m[1], 10);
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] || 'm'];
  return Date.now() - (n * mult);
}

function printHelp() {
  console.log(`metrics-query.mjs — inspect the unified metrics store

  --source S            filter by source (e.g. performance-monitor)
  --metric M            filter by metric name (e.g. cpu_pct)
  --since 10m|1h|30s    only records newer than this (default: all)
  --until 1m            only records older than this
  --limit N             cap result count (default 50)
  --tag key=value       require record.tags[key] === value (can repeat)

  --latest              print only the most recent matching record
  --agg                 numeric aggregate (n / avg / min / max) over the window
  --sources             list all distinct sources currently in the store
  --metrics             list all distinct metric names (optionally filtered by --source)

  --help, -h            this message
`);
}

const tagMatch = Object.keys(opts.tags).length ? opts.tags : null;

// ── modes ────────────────────────────────────────────────────────────────────
if (opts.listSources) {
  const recs = queryMetrics({ limit: 1_000_000 });
  const set = new Set(recs.map(r => r.source));
  console.log([...set].sort().join('\n') || '(no metrics recorded yet)');
  process.exit(0);
}

if (opts.listMetrics) {
  const recs = queryMetrics({ source: opts.source || undefined, limit: 1_000_000 });
  const set = new Set(recs.map(r => r.metric));
  console.log([...set].sort().join('\n') || '(no metrics recorded yet)');
  process.exit(0);
}

if (opts.latest) {
  if (!opts.source || !opts.metric) {
    console.error('--latest requires --source and --metric'); process.exit(1);
  }
  const r = latestMetric(opts.source, opts.metric, tagMatch);
  console.log(r ? JSON.stringify(r, null, 2) : '(no matching record)');
  process.exit(0);
}

if (opts.agg) {
  if (!opts.source || !opts.metric) {
    console.error('--agg requires --source and --metric'); process.exit(1);
  }
  const windowMs = opts.since ? (Date.now() - opts.since) : 60_000;
  const a = aggregateMetric(opts.source, opts.metric, windowMs, tagMatch);
  console.log(a ? JSON.stringify(a, null, 2) : '(no matching records in window)');
  process.exit(0);
}

// Default: list matching records
const recs = queryMetrics({
  source: opts.source,
  metric: opts.metric,
  since:  opts.since,
  until:  opts.until,
  limit:  opts.limit || 50,
  tagMatch,
});

if (!recs.length) { console.log('(no matching records)'); process.exit(0); }
for (const r of recs) {
  const when = new Date(r.ts).toISOString().replace('T', ' ').slice(0, 19);
  const tagStr = r.tags ? ' ' + Object.entries(r.tags).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  console.log(`${when}  ${r.source.padEnd(22)} ${r.metric.padEnd(20)} ${String(r.value).padStart(8)}${tagStr}`);
}
