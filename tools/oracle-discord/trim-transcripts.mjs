#!/usr/bin/env node
/**
 * trim-transcripts.mjs — ONE-TIME, owner-run transcript DB trimmer.
 *
 * Purpose: the transcripts.db has bloated (~191MB, ~127k rows, ~95% bot-to-bot
 * chatter, each message logged 2-3x). This script reclaims that space SAFELY.
 *
 * RUN THIS ONLY WITH THE FLEET STOPPED. SQLite WAL tolerates readers, but a
 * VACUUM needs an exclusive lock and the auto-retention in the live code would
 * otherwise race it. Stop all bots first, then: `node trim-transcripts.mjs`
 *
 * What it does, in order:
 *   1. BACKS UP transcripts.db to a timestamped copy. REFUSES to run if the
 *      backup can't be made (no destructive action without a safety copy).
 *   2. In a single transaction:
 *        • deletes RAW transcript_fts rows older than the retention window that
 *          were spoken by a known AI (bot-to-bot chatter), plus their
 *          message_meta sidecar rows;
 *        • removes EXACT duplicate transcript rows (same speaker+content+channel
 *          +timestamp), keeping the lowest rowid;
 *      It KEEPS: every human line (user_id in HUMAN_IDS) at any age, every
 *      [DIGEST] rollup, everything inside the window, and ALL structured-memory
 *      tables (user_profile_memories person/quote/profile facts; surviving
 *      message_meta rows).
 *   3. Rebuilds/optimizes the FTS index, then runs VACUUM to shrink the file.
 *   4. Prints before/after row counts + file size.
 *
 * Idempotent: running it twice is safe — the second pass finds nothing new to
 * delete. It clearly prints what it WILL delete before deleting (dry preview),
 * then performs the deletion in one transaction.
 *
 * Flags:
 *   --days=N        retention window in days (default env TRANSCRIPT_RETENTION_DAYS or 14)
 *   --dry-run       print what would be deleted, change NOTHING (no backup needed)
 *   --yes           skip the confirmation pause (for non-interactive runs)
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HUMAN_IDS, AI_IDS } from './shared/identities.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'transcripts.db');

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getFlag = (name) => args.find(a => a === `--${name}`) != null;
const getOpt = (name, def) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const DRY_RUN = getFlag('dry-run');
const SKIP_CONFIRM = getFlag('yes');
const RETENTION_DAYS = Math.max(1, Number(getOpt('days', process.env.TRANSCRIPT_RETENTION_DAYS || 14)));
const cutoff = Date.now() - RETENTION_DAYS * 86400000;

function fmtBytes(n) {
  if (n == null) return 'n/a';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${u[i]}`;
}
function fileSize(p) { try { return fs.statSync(p).size; } catch { return null; } }

console.log('───────────────────────────────────────────────');
console.log(' trim-transcripts.mjs  (RUN WITH FLEET STOPPED)');
console.log('───────────────────────────────────────────────');
console.log(`DB:              ${dbPath}`);
console.log(`Retention:       ${RETENTION_DAYS} days  (cutoff ${new Date(cutoff).toISOString()})`);
console.log(`Mode:            ${DRY_RUN ? 'DRY-RUN (no changes)' : 'LIVE'}`);
console.log(`Known humans:    ${HUMAN_IDS.size}   Known AIs: ${AI_IDS.size}`);
console.log('');

if (!fs.existsSync(dbPath)) {
  console.error(`FATAL: database not found at ${dbPath}`);
  process.exit(1);
}
if (AI_IDS.size === 0) {
  console.error('FATAL: no AI ids in identities.mjs — refusing to run (cannot tell chatter apart).');
  process.exit(1);
}

// ── 1. BACKUP (refuse to run live without one) ───────────────────────────────
const sizeBefore = fileSize(dbPath);
let backupPath = null;
if (!DRY_RUN) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  backupPath = path.join(__dirname, `transcripts.backup-${stamp}.db`);
  try {
    fs.copyFileSync(dbPath, backupPath);
    const bSize = fileSize(backupPath);
    if (!bSize || bSize !== sizeBefore) {
      throw new Error(`backup size mismatch (src ${sizeBefore} vs backup ${bSize})`);
    }
    console.log(`BACKUP OK:       ${backupPath}  (${fmtBytes(bSize)})`);
  } catch (e) {
    console.error(`FATAL: could not create a verified backup — REFUSING to proceed. ${e.message}`);
    process.exit(1);
  }
  // Also try to checkpoint+copy the WAL sidecar if present, so the backup is whole.
  for (const ext of ['-wal', '-shm']) {
    const src = dbPath + ext;
    if (fs.existsSync(src)) {
      try { fs.copyFileSync(src, backupPath + ext); } catch (_) { /* best effort */ }
    }
  }
}

// ── open DB ──────────────────────────────────────────────────────────────────
const db = new Database(dbPath, { timeout: 30000 });
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

const aiIds = [...AI_IDS];
const aiPh = aiIds.map(() => '?').join(',');

function count(sql, params = []) {
  try { return db.prepare(sql).get(...params)?.c ?? 0; } catch { return 0; }
}

// ── before counts + preview of exactly what will be deleted ──────────────────
const totalTranscripts = count(`SELECT COUNT(*) c FROM transcript_fts`);
const totalMeta = count(`SELECT COUNT(*) c FROM message_meta`);
const totalProfile = count(`SELECT COUNT(*) c FROM user_profile_memories`);
const humanRows = count(
  `SELECT COUNT(*) c FROM transcript_fts WHERE user_id IN (${[...HUMAN_IDS].map(() => '?').join(',') || "''"})`,
  [...HUMAN_IDS]);

const willDeleteOldChatter = count(
  `SELECT COUNT(*) c FROM transcript_fts
     WHERE timestamp < ? AND user_id IN (${aiPh}) AND content NOT LIKE '[DIGEST]%'`,
  [cutoff, ...aiIds]);

// Exact duplicates (same speaker+content+channel+timestamp) beyond the first.
const dupCount = count(
  `SELECT COUNT(*) c FROM (
     SELECT rowid,
            ROW_NUMBER() OVER (PARTITION BY speaker, content, channel_id, timestamp
                               ORDER BY rowid) AS rn
       FROM transcript_fts
   ) WHERE rn > 1`);

console.log('');
console.log('BEFORE:');
console.log(`  transcript_fts rows:        ${totalTranscripts.toLocaleString()}`);
console.log(`    └ human lines (KEPT):     ${humanRows.toLocaleString()}`);
console.log(`  message_meta rows:          ${totalMeta.toLocaleString()}  (structured — sidecar)`);
console.log(`  user_profile_memories rows: ${totalProfile.toLocaleString()}  (structured — PRESERVED)`);
console.log(`  file size:                  ${fmtBytes(sizeBefore)}`);
console.log('');
console.log('WILL DELETE:');
console.log(`  old bot-to-bot chatter (> ${RETENTION_DAYS}d, AI speakers, non-digest): ${willDeleteOldChatter.toLocaleString()}`);
console.log(`  exact duplicate transcript rows:                              ${dupCount.toLocaleString()}`);
console.log('WILL KEEP: all human lines, all [DIGEST] rollups, everything in-window,');
console.log('           and ALL structured tables (user_profile_memories, surviving message_meta).');
console.log('');

if (DRY_RUN) {
  console.log('DRY-RUN: no changes made. Re-run without --dry-run to apply.');
  db.close();
  process.exit(0);
}

if (!SKIP_CONFIRM) {
  console.log('Proceeding in 5s... (Ctrl-C to abort). Pass --yes to skip this pause.');
  const start = Date.now();
  while (Date.now() - start < 5000) { /* busy wait, no deps */ }
}

// ── 2. delete in ONE transaction ─────────────────────────────────────────────
let deletedMeta = 0, deletedChatter = 0, deletedDups = 0;
try {
  const tx = db.transaction(() => {
    // 2a. sidecar rows whose parent FTS row will be removed
    deletedMeta = db.prepare(
      `DELETE FROM message_meta
        WHERE fts_rowid IN (
          SELECT rowid FROM transcript_fts
           WHERE timestamp < ? AND user_id IN (${aiPh}) AND content NOT LIKE '[DIGEST]%'
        )`).run(cutoff, ...aiIds).changes || 0;

    // 2b. old bot-to-bot chatter (humans + digests excluded by construction)
    deletedChatter = db.prepare(
      `DELETE FROM transcript_fts
        WHERE timestamp < ? AND user_id IN (${aiPh}) AND content NOT LIKE '[DIGEST]%'`
    ).run(cutoff, ...aiIds).changes || 0;

    // 2c. exact duplicates anywhere (keep lowest rowid of each group)
    deletedDups = db.prepare(
      `DELETE FROM transcript_fts WHERE rowid IN (
         SELECT rowid FROM (
           SELECT rowid,
                  ROW_NUMBER() OVER (PARTITION BY speaker, content, channel_id, timestamp
                                     ORDER BY rowid) AS rn
             FROM transcript_fts
         ) WHERE rn > 1
       )`).run().changes || 0;

    // 2d. drop now-orphaned sidecar rows (parent removed by dedupe)
    db.prepare(
      `DELETE FROM message_meta
        WHERE fts_rowid NOT IN (SELECT rowid FROM transcript_fts)`).run();
  });
  tx();
} catch (e) {
  console.error(`FATAL: delete transaction failed — DB unchanged (rolled back). ${e.message}`);
  console.error(`Your backup is intact at: ${backupPath}`);
  db.close();
  process.exit(1);
}

// ── 3. optimize FTS + VACUUM ─────────────────────────────────────────────────
try { db.exec(`INSERT INTO transcript_fts(transcript_fts) VALUES('optimize');`); }
catch (e) { console.warn(`[warn] FTS optimize failed: ${e.message}`); }
try { db.exec(`INSERT INTO transcript_fts(transcript_fts) VALUES('rebuild');`); }
catch (e) { console.warn(`[warn] FTS rebuild skipped: ${e.message}`); }
try { db.exec('VACUUM;'); }
catch (e) { console.warn(`[warn] VACUUM failed: ${e.message}`); }

// ── 4. after counts + size ───────────────────────────────────────────────────
const afterTranscripts = count(`SELECT COUNT(*) c FROM transcript_fts`);
const afterMeta = count(`SELECT COUNT(*) c FROM message_meta`);
const afterProfile = count(`SELECT COUNT(*) c FROM user_profile_memories`);
db.close();
const sizeAfter = fileSize(dbPath);

console.log('');
console.log('DELETED:');
console.log(`  old chatter:        ${deletedChatter.toLocaleString()}`);
console.log(`  exact duplicates:   ${deletedDups.toLocaleString()}`);
console.log(`  sidecar (meta):     ${deletedMeta.toLocaleString()}`);
console.log('');
console.log('AFTER:');
console.log(`  transcript_fts rows:        ${afterTranscripts.toLocaleString()}  (was ${totalTranscripts.toLocaleString()})`);
console.log(`  message_meta rows:          ${afterMeta.toLocaleString()}  (was ${totalMeta.toLocaleString()})`);
console.log(`  user_profile_memories rows: ${afterProfile.toLocaleString()}  (was ${totalProfile.toLocaleString()}, PRESERVED)`);
console.log(`  file size:                  ${fmtBytes(sizeAfter)}  (was ${fmtBytes(sizeBefore)})`);
const saved = (sizeBefore ?? 0) - (sizeAfter ?? 0);
console.log(`  reclaimed:                  ${fmtBytes(saved)}`);
console.log('');
console.log(`DONE. Backup kept at: ${backupPath}`);
console.log('Restart the fleet when ready. Live retention will keep the DB bounded going forward.');
