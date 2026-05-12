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
import { djTTS } from './tts.mjs';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const STATE_FILE  = join(__dirname, '..', 'state', 'radio-state.json');
const STATE_TTL   = 6 * 60 * 60 * 1000; // 6 hours — ignore stale state after this

// Save state on hard kills too (SIGINT = Ctrl+C, SIGTERM = process manager kill)
function _handleShutdown() {
  if (djState.active) _saveState();
  process.exit(0);
}
process.once('SIGINT',  _handleShutdown);
process.once('SIGTERM', _handleShutdown);

function _saveState() {
  try {
    const payload = {
      playlistName:  djState.playlistName,
      playlistIndex: djState.playlistIndex,
      songQueue:     djState.songQueue,
      lastSong:      djState.currentSong
        ? { title: djState.currentSong.title, artist: djState.currentSong.artist }
        : null,
      savedAt: Date.now(),
    };
    writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (_) {}
}

function _loadState() {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const raw   = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!raw || Date.now() - raw.savedAt > STATE_TTL) return null;
    return raw;
  } catch (_) { return null; }
}

// ── Natural language radio intent parser ──────────────────────────────────────
// Returns { intent, song, playlist } or null if no radio intent detected.
export function parseRadioIntent(text) {
  const t = text.toLowerCase().trim();

  // Skip / Next
  if (/\b(skip|next song|next track|move on|skip (this|it)|play (something|the next))\b/.test(t)) {
    return { intent: 'skip' };
  }

  // Stop / Pause
  if (/\b(stop (the )?(music|radio|song)|pause|turn (it|the music) off|cut (it|the music))\b/.test(t)) {
    return { intent: 'stop' };
  }

  // Now playing
  if (/\b(what('?s| is) (playing|this( song)?)|what song (is this|are you playing)|now playing)\b/.test(t)) {
    return { intent: 'nowplaying' };
  }

  // Queue
  if (/\b(what('?s| is) (in |the )?(queue|next|coming up)|show (me )?(the )?queue)\b/.test(t)) {
    return { intent: 'queue' };
  }

  // Playlist switch — "play the hype playlist" / "switch to chill" / "run late-night"
  const playlistMatch = t.match(/\b(play|switch to|run|put on)\s+(the\s+)?(default|late.?night|hype|chill)\s+(playlist)?\b/);
  if (playlistMatch) {
    return { intent: 'playlist', playlist: playlistMatch[3].replace('-', '-') };
  }

  // Artist shuffle — "play some X songs" / "random funny X song" / "something from X"
  // Must run BEFORE general requestMatch to catch vague multi-word artist requests
  const shufflePatterns = [
    // "play some Lonely Island songs, random funny one"
    /\b(?:play\s+)?some\s+(.+?)\s+songs?/i,
    // "random song from The Lonely Island" / "a random Lonely Island song"
    /\b(?:a\s+)?(?:random|funny|popular|good)\s+(?:song|track|one)\s+(?:from|by)\s+(.+?)(?:\s+that.+)?$/i,
    // "something from The Lonely Island"
    /\bsomething\s+(?:from|by)\s+(.+?)(?:\s+(?:please|thanks))?$/i,
    // "play The Lonely Island, something funny"
    /^play\s+(.+?),\s+(?:something|a song|random|any)/i,
  ];
  for (const pat of shufflePatterns) {
    const m = t.match(pat);
    if (m) {
      const artist = m[1].trim().replace(/[.,!?]+$/, '');
      if (artist.length > 1) {
        const mood = /funny|comedy|hype|sad|chill|party/.exec(t)?.[0] || '';
        return { intent: 'artist_shuffle', artist, mood };
      }
    }
  }

  // Song request — "play X" / "put on X" / "queue X" / "can you play X" / "I want to hear X"
  const requestMatch = t.match(
    /\b(?:play|put on|queue(?: up)?|add|request|can you play|i(?:'d)? want (?:to hear|to listen to)?)\s+(.+?)(?:\s+(?:please|next|now|for me))?$/i
  );
  if (requestMatch) {
    let song = requestMatch[1].trim();
    // Reject if it's a vague descriptor rather than a song title
    const VAGUE = /^(songs?|tracks?|music|random|something|anything|some|funny|popular)$/i;
    if (VAGUE.test(song)) {
      // It's literally just a vague word like "songs"
      return null;
    } else {
      // It has actual content (like "tech9 songs" or "metallica")
      song = song.replace(/^(?:some|a|the|random|any)\s+/i, '').trim();
      // Also strip trailing "songs" if they said "play tech9 songs"
      song = song.replace(/\s+songs?$/i, '').trim();
      if (song.length > 1) {
        // Automatically fetch long versions for ambient/study/sleep sounds
        const ambientKeywords = /\b(rain|sleep|study|focus|ambient|background|ocean|storm|thunder|nature|lofi|lo-fi)\b/i;
        const timeKeywords = /\b(\d+\s*hours?|24\/?7|live)\b/i;
        if (ambientKeywords.test(song) && !timeKeywords.test(song)) {
          song = `${song} 10 hours`;
        }
        return { intent: 'request', song };
      }
    }
  }

  // "X by Y" — artist mention is the strongest non-keyword signal
  // e.g. "Mother Lover by The Lonely Island" or "Blinding Lights by The Weeknd."
  const byMatch = text.trim().match(/^(.+?)\s+by\s+([^?!]+?)[.!?]?\s*$/i);
  if (byMatch) {
    const title  = byMatch[1].trim();
    const artist = byMatch[2].trim();
    const noMatch = ['nothing', 'someone', 'something', 'anyone', 'everyone'];
    if (title.length > 1 && !noMatch.includes(title.toLowerCase())) {
      return { intent: 'request', song: `${title} - ${artist}` };
    }
  }

  // "Title - Artist" bare dash format  e.g. "Blinding Lights - The Weeknd"
  const dashOnly = text.trim().match(/^([^?!-]+)\s+-\s+([^?!]+?)[.!?]?\s*$/i);
  if (dashOnly && text.trim().length <= 80) {
    return { intent: 'request', song: text.trim().replace(/[.!?]+$/, '') };
  }

  // Suggestions / Recommendations
  if (/\b(suggest|recommend|what should i play|give me some (ideas|choices|options)|what's good|top 5)\b/.test(t)) {
    const artistMatch = t.match(/(?:from|by|of)\s+(.+?)(?:\s|$)/);
    return { intent: 'suggest', artist: artistMatch?.[1]?.trim() || '' };
  }

  return null;
}

/**
 * Handle a radio intent extracted from voice or text.
 * @param {string} text  — raw transcript
 * @param {Function} speakFn — Leo's TTS function
 * @param {string} requestedBy — username
 * @param {boolean} isOwner — Ryan or Taz (can skip/stop)
 * @returns {boolean} true if handled, false if Leo should respond normally
 */
export async function handleRadioVoiceIntent(text, speakFn, requestedBy = 'someone', isOwner = false) {
  // We removed if (!djState.active) return false; here so Groq can accept requests while offline

  const intent = parseRadioIntent(text);
  if (!intent) return false;

  switch (intent.intent) {
    case 'request': {
      const parts = intent.song.split(/\s*-\s*/);
      const title  = parts[0].trim();
      const artist = parts[1]?.trim() || '';
      const result = await addRequest(title, artist, requestedBy);
      const confirmations = [
        `got it, ${title} is ${result === 'pooled' ? 'in the vote pool' : 'queued'}.`,
        `${title} — added.`,
        `alright, ${title} is ${result === 'pooled' ? 'going to the poll' : 'in the queue'}.`,
        `${title} queued up.`,
      ];
      await speakFn(confirmations[Math.floor(Math.random() * confirmations.length)]);
      return true;
    }
    case 'artist_shuffle': {
      // Search for a specific popular/mood-based song by the artist
      const { artist, mood } = intent;
      const searchQ = `${artist} ${mood || 'popular'} song audio`;
      const meta = await resolveSongMeta(searchQ);
      // Use the resolved title but always credit the requested artist
      const resolvedTitle = meta.title
        .replace(/\s*[\[(](?:official|audio|video|lyrics?|hd|4k)[^)\]]*[)\]]\s*/gi, '')
        .trim();
      const result = await addRequest(resolvedTitle, artist, requestedBy);
      await speakFn(`got it — queuing ${resolvedTitle} by ${artist} for ${requestedBy}.`);
      return true;
    }
    case 'skip': {
      if (!isOwner) {
        await speakFn(`only ryan or taz can skip.`);
        return true;
      }
      await speakFn(`skipping.`);
      djState.skipping = true;      // suppress transition talk in _onSongEnd
      djState.nextAnnounced = false; // force fresh announcement for next song
      djState.audioPlayer?.stop();
      return true;
    }
    case 'stop': {
      if (!isOwner) {
        await speakFn(`only ryan or taz can stop the radio.`);
        return true;
      }
      await speakFn(`alright, stopping.`);
      stopDJ();
      return true;
    }
    case 'nowplaying': {
      await speakFn(getStatus());
      return true;
    }
    case 'queue': {
      const q = getQueue();
      if (q.length === 0) {
        await speakFn(`queue's empty right now.`);
      } else {
        const listed = q.slice(0, 4).map(s => s.title).join(', ');
        await speakFn(`up next: ${listed}${q.length > 4 ? `, and ${q.length - 4} more` : ''}.`);
      }
      return true;
    }
    case 'playlist': {
      await startPlaylist(intent.playlist);
      await speakFn(`switching to the ${intent.playlist} playlist.`);
      return true;
    }
    case 'suggest': {
      const { searchTopChoices } = await import('./music-player.mjs');
      const query = intent.artist || djState.currentSong?.artist || 'popular';
      const choices = await searchTopChoices(query);
      if (choices.length === 0) {
        await speakFn(`i'm drawing a blank on ${query}. hit me with a specific title.`);
      } else {
        const list = choices.map((c, i) => `${i + 1}. ${c.title}`).join(', ');
        await speakFn(`here's the top 5 for ${query}: ${list}. say the number or the title to play one.`);
        // Store choices in state for quick selection
        djState.lastSuggestions = choices;
      }
      return true;
    }
  }

  return false;
}

const REQUEST_WINDOW_BEFORE_END_MS = 40_000; // open window 40s before song ends
const POLL_DURATION_SECONDS        = 20;      // Discord poll lives 20s
const DIM_DELAY_MS                 = 800;     // brief pause after dimming before speech
const MIN_SONG_DURATION_FOR_WINDOW = 60;      // don't open window on songs < 60s

// ── State ─────────────────────────────────────────────────────────────────────
let djState = {
  active:            false,
  voiceConnection:   null,
  audioPlayer:       null,
  currentResource:   null,
  currentSong:       null,
  songQueue:         [],
  requestPool:       [],
  requestWindowOpen: false,
  playingTTS:        false,   // true while TTS is occupying audioPlayer
  nextAnnounced:     false,   // true when _closeRequestWindow already announced next song
  transitioning:     false,   // true while _onSongEnd is running (prevents double-fire)
  skipping:          false,   // true when user explicitly skipped (suppress transition talk)
  playlistMode:      true,
  playlistName:      'default',
  playlistIndex:     0,
  windowTimer:       null,
  fadeTimer:         null,    // scheduled fade-out before song ends
  pollMessage:       null,
  textChannel:       null,
  guild:             null,
  lastSuggestions:   [],      // top 5 choices from last 'suggest' command
  lastArtist:        null,    // track last artist for awareness
};

// ── Exported API ──────────────────────────────────────────────────────────────

/**
 * Start DJ mode. Called when Leo joins the radio voice channel.
 * @param {VoiceBasedChannel} voiceChannel
 * @param {TextChannel} textChannel
 * @param {Guild} guild
 */
export async function startDJ(voiceChannel, textChannel, guild) {
  if (djState.active) return;

  // Restore previous session state if available
  const saved = _loadState();
  if (saved) {
    djState.playlistName  = saved.playlistName  || 'default';
    djState.playlistIndex = saved.playlistIndex || 0;
    djState.songQueue     = saved.songQueue     || [];
    // We NO LONGER unshift the last song, as it causes duplicates on restart.
    // We just keep it in saved.lastSong to influence the next transition.
    djState.lastSong = saved.lastSong;
  }

  djState.guild       = guild;
  djState.textChannel = textChannel;
  djState.active      = true;
  djState.playlistMode = true;

  // Initial Playlist Load (if queue is empty)
  if (djState.songQueue.length === 0) {
    const list = getPlaylist(djState.playlistName);
    djState.songQueue = _shuffle([...list]);
  }

  djState.voiceConnection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId:   guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  djState.audioPlayer = createRadioPlayer();
  djState.voiceConnection.subscribe(djState.audioPlayer);

  // Only trigger _onSongEnd when MUSIC (not TTS) finishes
  djState.audioPlayer.on('stateChange', async (oldS, newS) => {
    if (newS.status === 'idle' && oldS.status === 'playing' && !djState.playingTTS) {
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
  const intro = saved?.lastSong
    ? `back on air. picking up where we left off.`
    : `radio's live. i'm your dj. drop a request in the chat or just vibe.`;
  
  await _djSpeak(intro);
  
  if (textChannel) {
    textChannel.send('🎙️ **Leo Radio** is live — say or type what you want to hear. Playlists: `default` `hype` `chill` `late-night`').catch(() => {});
  }
  
  await _playNextSong();
}

/** Stop DJ mode cleanly */
export function stopDJ() {
  if (djState.windowTimer) clearTimeout(djState.windowTimer);
  if (djState.fadeTimer)   clearTimeout(djState.fadeTimer);
  _saveState(); // persist before destroying state
  djState.audioPlayer?.stop(true);
  // djState.voiceConnection?.destroy(); // Keep Groq in the channel silently
  Object.assign(djState, {
    active: false, audioPlayer: null,
    currentResource: null, currentSong: null, songQueue: [],
    requestPool: [], requestWindowOpen: false, windowTimer: null,
    fadeTimer: null, transitioning: false,
    pollMessage: null, textChannel: null, guild: null,
    playingTTS: false, nextAnnounced: false,
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
  
  // SHUFFLE: Use Fisher-Yates to ensure true randomness
  const shuffled = [...list];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  
  djState.songQueue = shuffled;
  console.log(`[Radio] Playlist "${name}" loaded and shuffled — ${djState.songQueue.length} songs`);
}

function _shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
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

/** Speak via TTS through djState.audioPlayer AND post to radio text channel */
async function _djSpeak(text) {
  if (!djState.active || !djState.audioPlayer) return;
  // Post to text channel immediately (non-blocking)
  if (djState.textChannel) {
    djState.textChannel.send(`🎙️ ${text}`).catch(() => {});
  }

  // Check if anyone is actually listening
  const guild = djState.guild;
  const connection = djState.voiceConnection;
  let hasListeners = false;
  
  if (guild && connection) {
    const channelId = connection.joinConfig.channelId;
    const channel = guild.channels.cache.get(channelId);
    if (channel) {
      const nonBotMembers = channel.members?.filter(m => !m.user.bot);
      if (nonBotMembers && nonBotMembers.size > 0) {
        hasListeners = true;
      }
    }
  }

  if (!hasListeners) {
    console.log(`[Radio] Channel empty, skipping TTS: "${text}"`);
    return;
  }

  // Synthesize and play through the DJ's own audio player
  djState.playingTTS = true;
  try {
    await djTTS(text, djState.audioPlayer);
  } finally {
    djState.playingTTS = false;
  }
}

/**
 * Play the next song.
 * @param {object} preloaded - { resource, ytdlpProc }
 * @param {object} preselectedSong - The song object already picked by _onSongEnd
 */
async function _playNextSong(preloaded = null, preselectedSong = null) {
  if (!djState.active) return;

  // Use the preselected song if provided (matches the preloaded audio)
  let song = preselectedSong || djState.songQueue.shift();

  // If still no song (manual trigger?), fall back to the playlist
  if (!song && djState.playlistMode) {
    const list = getPlaylist(djState.playlistName);
    if (list.length > 0) {
      song = list[djState.playlistIndex % list.length];
      djState.playlistIndex++;
    }
  }

  if (!song) {
    await _djSpeak("queue's empty. drop a request or say which playlist you want.");
    return;
  }

  djState.lastArtist = song.artist || null;

  // Build search query
  const query = `${song.title} ${song.artist || ''}`.trim();

  // If preloaded stream matches this song, skip the yt-dlp meta + stream calls
  // (saves ~5-10s of sequential yt-dlp latency)
  let duration = 240;
  if (!preloaded) {
    const meta = await resolveSongMeta(query);
    duration = (meta.duration && meta.duration >= 30) ? meta.duration : 240;
  }

  djState.currentSong = {
    ...song,
    title:     song.title,
    artist:    song.artist || '',
    duration,
    startedAt: Date.now(),
  };

  // Save state now — captures current song even if process is killed before stopDJ()
  _saveState();

  console.log(`[Radio] Streaming: ${song.title} — ${song.artist || ''} (~${duration}s)`);

  // Announce — use clean playlist title/artist (not yt-dlp meta which pollutes titles)
  if (!djState.nextAnnounced) {
    const reqBy  = song.requestedBy && song.requestedBy !== 'playlist' ? song.requestedBy : null;
    const a      = song.artist || '';
    const t      = song.title;
    const lines  = [
      `alright, here we go — ${t}${a ? ` by ${a}` : ''}.`,
      `next up: ${t}${a ? `, ${a}` : ''}.${reqBy ? ` this one's for ${reqBy}.` : ''}`,
      `${t}${a ? ` — ${a}` : ''} coming in hot.`,
      `rolling into ${t}${a ? ` by ${a}` : ''} now.`,
    ];
    await _djSpeak(lines[Math.floor(Math.random() * lines.length)]);
  }
  djState.nextAnnounced = false;

  // Post Now Playing embed to radio text channel
  if (djState.textChannel) {
    djState.textChannel.send({
      embeds: [{
        color: 0x9b59b6,
        author: { name: '▶️  Now Playing' },
        title: djState.currentSong.title,
        description: djState.currentSong.title.includes(' - ') ? undefined : (song.artist ? `**${song.artist}**` : undefined),
        footer: (song.requestedBy && song.requestedBy !== 'playlist') ? { text: `Requested by ${song.requestedBy}` } : { text: 'From playlist' },
        timestamp: new Date().toISOString(),
      }]
    }).catch(() => {});
  }

  // Use preloaded stream if available (launched during TTS to reduce gap)
  const { resource, ytdlpProc } = preloaded || streamSong(query);
  djState.currentResource = resource;

  // Handle stream errors (EPIPE, etc)
  ytdlpProc.on('error', err => {
    console.error('[Radio/Stream] Process error:', err.message);
    if (djState.active) {
      console.log('[Radio/Stream] Attempting recovery...');
      _playNextSong().catch(() => {});
    }
  });

  ytdlpProc.stderr?.on('data', d => {
    const msg = d.toString();
    if (msg.includes('WARNING')) console.warn('[Radio/yt-dlp]', msg.trim());
  });

  // Start silent, fade in over 3s for smooth entry
  resource.volume?.setVolume(0);
  djState.audioPlayer.play(resource);
  _fadeIn().catch(() => {});

  // Schedule fade-out to begin 10s before song ends (only for reasonable durations)
  if (djState.fadeTimer) clearTimeout(djState.fadeTimer);
  if (duration >= 30) {
    const fadeDelay = Math.max(15_000, (duration - 10) * 1_000);
    djState.fadeTimer = setTimeout(() => _fadeOut().catch(() => {}), fadeDelay);
  }

  // Schedule request window (40s before end)
  if (duration >= MIN_SONG_DURATION_FOR_WINDOW) {
    const windowDelay = Math.max(0, (duration - 40) * 1000);
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
    djState.nextAnnounced = true;
    // Text-only confirmation — do NOT call _djSpeak() here.
    // _djSpeak stops the music (TTS takes over the player). After TTS the player
    // goes idle but _onSongEnd never fires (playingTTS guards it). Radio hangs.
    // The song continues playing naturally; _onSongEnd → _playNextSong handles the rest.
    if (djState.textChannel) {
      djState.textChannel.send(
        `🎙️ got it — **${pool[0].title}** from ${pool[0].requestedBy} is up next.`
      ).catch(() => {});
    }
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

  await _djSpeak(
    `got ${candidates.length} requests — putting it to a vote. ${POLL_DURATION_SECONDS} seconds.`
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
  await _djSpeak(`${winner.title} won the vote — that's next.`);
}

async function _onSongEnd() {
  if (!djState.active) return;
  if (djState.transitioning) return; // prevent double-fire from fade + natural end
  djState.transitioning = true;

  const wasSkip = djState.skipping;
  djState.skipping = false;

  if (djState.fadeTimer)  { clearTimeout(djState.fadeTimer);  djState.fadeTimer  = null; }
  if (djState.windowTimer) { clearTimeout(djState.windowTimer); djState.windowTimer = null; }

  // Determine EXACTLY what song is next so the preload matches the metadata
  let nextSong = djState.songQueue.shift();
  
  // DUPLICATE GUARD: If the next song is literally the one we just played, skip it
  const prev = djState.currentSong;
  if (nextSong && prev && nextSong.title === prev.title && nextSong.artist === prev.artist) {
    console.log(`[Radio] Duplicate detected (${nextSong.title}) — skipping to next.`);
    nextSong = djState.songQueue.shift();
  }

  if (!nextSong && djState.playlistMode) {
    const list = getPlaylist(djState.playlistName);
    if (list.length > 0) {
      // Pick next in sequence or random, but DO NOT pick a random one again later
      let index = djState.playlistIndex % list.length;
      nextSong = list[index];
      
      // Secondary duplicate guard for playlist sequence
      if (prev && nextSong.title === prev.title && nextSong.artist === prev.artist) {
        index = (djState.playlistIndex + 1) % list.length;
        nextSong = list[index];
        djState.playlistIndex++;
      }
      
      djState.playlistIndex++; 
    }
  }

  // Pre-launch the yt-dlp stream NOW — it runs while Leo talks (saves 5-10s latency)
  let preloaded = null;
  if (nextSong) {
    console.log(`[Radio] Pre-loading next song: ${nextSong.title}`);
    const q = `${nextSong.title} ${nextSong.artist || ''}`.trim();
    preloaded = streamSong(q);
  }

  // Skip transition talk if user explicitly skipped — they already heard "skipping."
  if (!wasSkip) {
    const prev = djState.currentSong;
    const djLine = _buildTransitionLine(prev, nextSong);
    await _djSpeak(djLine);
  }

  djState.transitioning = false;
  await _playNextSong(preloaded, nextSong);
}

function _buildTransitionLine(prev, next) {
  const prevTitle = prev?.title || 'that one';
  // Strip YouTube junk like "(Official Video)" "[Audio]" etc
  const cleanTitle = (t) => t.replace(/\s*[\[(](?:official|audio|video|lyrics?|hd|4k|mv)[^)\]]*[)\]]\s*/gi, '').trim();
  const prevStr = cleanTitle(prevTitle);
  const nextStr = next ? cleanTitle(next.title) : null;
  const reqBy   = next?.requestedBy && next.requestedBy !== 'playlist' ? ` — requested by ${next.requestedBy}` : '';

  if (!nextStr) {
    const empties = [
      `that was ${prevStr}. queue's looking empty — drop a request.`,
      `${prevStr} — nice one. queue's dry, hit me with something.`,
      `wrapping up ${prevStr}. nothing queued up — what do you want to hear?`,
    ];
    return empties[Math.floor(Math.random() * empties.length)];
  }

  const transitions = [
    `that was ${prevStr}. next up we got ${nextStr}${reqBy}.`,
    `${prevStr} — solid track. keeping it moving with ${nextStr}${reqBy}.`,
    `alright, ${prevStr} done. rolling into ${nextStr} now${reqBy}.`,
    `coming out of ${prevStr}, sliding right into ${nextStr}${reqBy}.`,
    `good stuff. ${nextStr} is up next${reqBy}.`,
  ];

  return transitions[Math.floor(Math.random() * transitions.length)];
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Audio fade helpers ────────────────────────────────────────────────────────

/** Gradually fade current music resource from 1.0 → 0 over ~4s, then stop. */
async function _fadeOut() {
  const STEPS = 20, DURATION_MS = 4_000;
  const stepMs = DURATION_MS / STEPS;
  for (let i = STEPS - 1; i >= 0; i--) {
    if (!djState.active || djState.playingTTS || djState.transitioning) return;
    try { djState.currentResource?.volume?.setVolume(i / STEPS); } catch (_) {}
    await _sleep(stepMs);
  }
  // Once silent, stop the player — triggers _onSongEnd via stateChange
  if (djState.active && !djState.playingTTS && !djState.transitioning) {
    console.log('[Radio] Fade-out complete — stopping stream');
    djState.audioPlayer?.stop();
  }
}

/** Ramp current music resource from 0 → 1.0 over ~2s after song starts. */
async function _fadeIn() {
  const STEPS = 20, DURATION_MS = 2_000;
  const stepMs = DURATION_MS / STEPS;
  for (let i = 1; i <= STEPS; i++) {
    if (!djState.active || djState.playingTTS) return;
    try { djState.currentResource?.volume?.setVolume(i / STEPS); } catch (_) {}
    await _sleep(stepMs);
  }
}
