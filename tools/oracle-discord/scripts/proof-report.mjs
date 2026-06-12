#!/usr/bin/env node
import { buildProofSummary, writeProofArtifacts } from '../shared/proof-metrics.mjs';

const summary = buildProofSummary();
const paths = writeProofArtifacts(summary);

console.log(JSON.stringify({
  ok: true,
  generatedAt: summary.generatedAt,
  paths
}, null, 2));
