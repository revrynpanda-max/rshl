/**
 * Single fleet build stamp — synced to Cargo.toml [package] version.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
let _cached = null;

export function getFleetBuildVersion() {
  if (_cached) return _cached;
  try {
    const cargoPath = path.resolve(_dir, '../../../Cargo.toml');
    const text = fs.readFileSync(cargoPath, 'utf8');
    const m = text.match(/^version\s*=\s*"([^"]+)"/m);
    _cached = m ? `v${m[1]}` : 'v0.0.0';
  } catch (_) {
    _cached = 'v0.0.0';
  }
  return _cached;
}

export function fleetBuildReadyLine(botName) {
  return `[${String(botName || '').trim()}/Ready] FLEET_BUILD=${getFleetBuildVersion()}`;
}