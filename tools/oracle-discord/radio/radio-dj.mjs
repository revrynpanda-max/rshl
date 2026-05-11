/**
 * radio-dj.mjs — Leo's AI Radio DJ Controller
 *
 * Full state machine:
 *   Song playing → request window opens (40s before end)
 *   → 2+ requests: Discord poll (20s) → winner queued
 *   → 1 request: auto-queued, no poll
 *   → 0 requests: next playlist song queued
 *   → song ends → dim music → Leo DJ talk (TTS) → next song plays
 */

import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { streamSong, createRadioPlayer, dimVolume, restoreVolume, resolveSongMeta } from './music-player.mjs';
import { getPlaylist, getPlaylistNames } from './playlists.mjs';
import { CHANNEL_IDS } from '../shared/channel-rules.mjs';

const REQUEST_WINDOW_BEFORE_END_MS = 40_000; // open window 40s before song ends
const POLL_DURATION_SECONDS        = 20;      // Discord poll lives 20s
const DIM_DELAY_MS                 = 800;     // brief pause after dimming before speech
const MIN_SONG_DURATION_FOR_WINDOW = 60;      // don't open window on songs < 60s

// ── State ─────────────────────────────────────────────────────────────────────
let djState = {
  active:          false,
  voiceConnection: null,
  audioPlayer:     null,
  currentResource: null,
  currentSong:     null,       // { title, artist, requestedBy, startedAt, duration }
  songQueue:       [],         // next songs to play
  requestPool:     [],         // requests received during the window
  requestWindowOpen: false,
  playlistMode:    false,
  playlistName:    'default',
  playlistIndex:   0,
  windowTimer:     null,
  pollMessage:     null,       // Discord poll message reference
  textChannel:     null,       // radio text channel for polls / !queue output
  guild:           null,
  speakFn:         null,       // (text) => Promise — Leo's TTS function
};

// ── Exported API ──────────────────────────────────────────────────────────────

/**
 * Start DJ mode. Called when Leo joins the radio voice channel.
 * @param {VoiceBasedChannel} voiceChannel
 * @param {TextChannel} textChannel
 * @param {Guild} guild
 * @param {Function} speakFn  async (text) => void — Leo's ElevenLabs TTS
 */
export async function startDJ(voiceChannel, textChannel, guild, speakFn) {
  if (djState.active) return;

  djState.guild       = guild;
  djState.textChannel = textChannel;
  djState.speakFn     = speakFn;
  djState.active      = true;
  djState.playlistMode = true;

  djState.voiceConnection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId:   guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  djState.audioPlayer = createRadioPlayer();
  djState.voiceConnection.subscribe(djState.audioPlayer);

  djState.audioPlayer.on('stateChange', async (oldS, newS) => {
    // Song finished naturally
    if (newS.status === 'idle' && oldS.status === 'playing') {
      await _onSongEnd();
    }
  });

  try {
    await entersState(djState.voiceConnection, VoiceConnectionStatus.Ready, 10_000);
  } catch {
    console.error('[Radio] Voice connection failed');
    stopDJ();
    return;
  }

  console.log('[Radio] DJ mode active');
  await speakFn("yo, radio's live. i'm your dj tonight. drop a !request or i'll run the default playlist.");
  await _playNextSong();
}

/** Stop DJ mode cleanly */
export function stopDJ() {
  if (djState.windowTimer) clearTimeout(djState.windowTimer);
  djState.audioPlayer?.stop(true);
  djState.voiceConnection?.destroy();
  Object.assign(djState, {
    active: false, voiceConnection: null, audioPlayer: null,
    currentResource: null, currentSong: null, songQueue: [],
    requestPool: [], requestWindowOpen: false, windowTimer: null,
    pollMessage: null, textChannel: null, guild: null, speakFn: null
  });
  console.log('[Radio] DJ mode stopped');
}

/** Add a song request (from a user) */
export async function addRequest(title, artist = '', requestedBy = 'someone') {
  const song = { title, artist, requestedBy };

  if (djState.requestWindowOpen) {
    // Window is open — goes to pool for poll
    djState.requestPool.push(song);
    console.log(`[Radio] Request added to pool: ${title} (pool size: ${djState.requestPool.length})`);
    // If this is the 2nd request, fire poll immediately
    if (djState.requestPool.length === 2) {
      await _runPoll();
    }
    return 'pooled';
  } else {
    // Outside window — goes straight to queue
    djState.songQueue.push(song);
    console.log(`[Radio] Request queued: ${title} (queue size: ${djState.songQueue.length})`);
    return 'queued';
  }
}

/** Start a named playlist */
export async function startPlaylist(name = 'default') {
  djState.playlistMode  = true;
  djState.playlistName  = name;
  djState.playlistIndex = 0;
  const list = getPlaylist(name);
  djState.songQueue = [...list]; // copy so mutations don't affect original
  console.log(`[Radio] Playlist "${name}" loaded — ${djState.songQueue.length} songs`);
}

/** Returns current status string */
export function getStatus() {
  if (!djState.active) return 'Radio offline.';
  const cs = djState.currentSong;
  const q  = djState.songQueue.length;
  if (!cs) return 'Loading first song...';
  return `Now playing: **${cs.title}${cs.artist ? ` — ${cs.artist}` : ''}** | Queue: ${q} song${q !== 1 ? 's' : ''}`;
}

/** Returns current queue as array of { title, artist, requestedBy } */
export function getQueue() {
  return djState.songQueue.slice();
}

export function isDJActive() { return djState.active; }

// ── Internal ──────────────────────────────────────────────────────────────────

async function _playNextSong() {
  if (!djState.active) return;

  let song = djState.songQueue.shift();

  // Fall back to playlist if queue is empty
  if (!song && djState.playlistMode) {
    const list = getPlaylist(djState.playlistName);
    if (list.length === 0) {
      await djState.speakFn("queue's dry, i got nothing. drop a !request.");
      return;
    }
    song = list[djState.playlistIndex % list.length];
    djState.playlistIndex++;
  }

  if (!song) {
    await djState.speakFn("queue's empty. drop a !request or type !playlist to run a playlist.");
    return;
  }

  // Resolve real metadata
  const query = `${song.title} ${song.artist || ''}`.trim();
  const meta  = await resolveSongMeta(query);
  djState.currentSong = {
    ...song,
    title:     meta.title || song.title,
    duration:  meta.duration,
    startedAt: Date.now(),
  };

  console.log(`[Radio] Streaming: ${djState.currentSong.title} (~${meta.duration}s)`);

  const { resource, ytdlpProc } = streamSong(query);
  djState.currentResource = resource;

  ytdlpProc.stderr?.on('data', d => {
    const msg = d.toString();
    if (!msg.includes('WARNING')) return; // silence normal yt-dlp info
    console.warn('[Radio/yt-dlp]', msg.trim());
  });

  djState.audioPlayer.play(resource);

  // Schedule request window
  if (meta.duration >= MIN_SONG_DURATION_FOR_WINDOW) {
    const windowDelay = Math.max(0, (meta.duration - 40) * 1000);
    if (djState.windowTimer) clearTimeout(djState.windowTimer);
    djState.windowTimer = setTimeout(_openRequestWindow, windowDelay);
  }
}

function _openRequestWindow() {
  if (!djState.active) return;
  djState.requestWindowOpen = true;
  djState.requestPool = [];
  console.log('[Radio] Request window open');

  // Close window and decide what's next after 30s
  setTimeout(_closeRequestWindow, 30_000);
}

async function _closeRequestWindow() {
  djState.requestWindowOpen = false;
  const pool = djState.requestPool;
  console.log(`[Radio] Request window closed — ${pool.length} request(s)`);

  if (pool.length === 0) {
    // Nothing requested — playlist continues automatically via _onSongEnd
    return;
  }

  if (pool.length === 1) {
    // Single request — auto-queue it, no poll needed
    djState.songQueue.unshift(pool[0]);
    await djState.speakFn(
      `got a request — ${pool[0].title} from ${pool[0].requestedBy} is up next.`
    );
    return;
  }

  // 2+ requests — poll (may already be running from _runPoll)
  if (!djState.pollMessage) {
    await _runPoll();
  }
}

async function _runPoll() {
  if (!djState.textChannel || djState.requestPool.length < 2) return;

  const candidates = djState.requestPool.slice(0, 5); // max 5 poll options
  console.log(`[Radio] Running poll with ${candidates.length} songs`);

  await djState.speakFn(
    `got ${candidates.length} requests coming in — putting it to a vote. you've got ${POLL_DURATION_SECONDS} seconds.`
  );

  try {
    const pollMsg = await djState.textChannel.send({
      content: '🎵 **Vote for the next song:**',
      poll: {
        question: { text: 'What plays next?' },
        answers: candidates.map(s => ({
          poll_media: { text: `${s.title}${s.artist ? ` — ${s.artist}` : ''} (req: ${s.requestedBy})` }
        })),
        duration: Math.ceil(POLL_DURATION_SECONDS / 3600) || 1, // Discord needs hours (min 1)
        allow_multiselect: false,
      }
    });
    djState.pollMessage = pollMsg;

    // Wait for poll duration then read winner
    setTimeout(async () => {
      await _resolvePoll(candidates);
    }, POLL_DURATION_SECONDS * 1000);

  } catch (e) {
    console.error('[Radio] Poll creation failed:', e.message);
    // Fallback: first request wins
    djState.songQueue.unshift(candidates[0]);
    await djState.speakFn(`poll failed — going with the first request: ${candidates[0].title}.`);
  }
}

async function _resolvePoll(candidates) {
  let winner = candidates[0]; // default to first

  if (djState.pollMessage) {
    try {
      // Fetch fresh message to get poll results
      const fresh = await djState.pollMessage.fetch();
      const results = fresh.poll?.results?.answer_counts || [];
      let maxVotes = -1;
      results.forEach((r, i) => {
        if (candidates[i] && r.count > maxVotes) {
          maxVotes = r.count;
          winner = candidates[i];
        }
      });
    } catch (e) {
      console.warn('[Radio] Could not fetch poll results:', e.message);
    }
    djState.pollMessage = null;
  }

  djState.songQueue.unshift(winner);
  await djState.speakFn(
    `${winner.title} won the vote — that's up next.`
  );
}

async function _onSongEnd() {
  if (!djState.active) return;
  if (djState.windowTimer) { clearTimeout(djState.windowTimer); djState.windowTimer = null; }

  const prev = djState.currentSong;
  const next  = djState.songQueue[0] || null;

  // Dim music (it's already ended but dim just in case there's overlap)
  dimVolume(djState.currentResource);
  await _sleep(DIM_DELAY_MS);

  // DJ talk between tracks
  const djLine = _buildTransitionLine(prev, next);
  await djState.speakFn(djLine);

  // Small gap feel
  await _sleep(500);

  // Play next
  await _playNextSong();
}

function _buildTransitionLine(prev, next) {
  const prevStr = prev?.title || 'that one';
  const nextStr = next ? `${next.title}${next.artist ? ` by ${next.artist}` : ''}` : null;

  if (!nextStr) {
    return `that was ${prevStr}. queue's looking empty — hit me with a !request.`;
  }

  const transitions = [
    `that was ${prevStr}. next up: ${nextStr}.`,
    `${prevStr} — solid. keeping it going with ${nextStr}.`,
    `alright, ${prevStr} done. rolling into ${nextStr} now.`,
    `that was ${prevStr}. coming in next — ${nextStr}.`,
  ];

  return transitions[Math.floor(Math.random() * transitions.length)];
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
