import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { createWriteStream, unlinkSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import sdk from 'microsoft-cognitiveservices-speech-sdk';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || 'eastus';
const DISCORD_TOKEN = process.env.CLAUDEY_DISCORD_TOKEN;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

let connection = null;
let player = null;

async function synthesizeSpeech(text) {
  const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
  speechConfig.speechSynthesisVoiceName = 'en-US-GuyNeural';
  
  const audioConfig = sdk.AudioConfig.fromAudioFileOutput('claudey_tts_output.wav');
  const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

  return new Promise((resolve, reject) => {
    synthesizer.speakTextAsync(
      text,
      result => {
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          synthesizer.close();
          resolve('claudey_tts_output.wav');
        } else {
          synthesizer.close();
          reject(new Error(`Speech synthesis failed: ${result.errorDetails}`));
        }
      },
      error => {
        synthesizer.close();
        reject(error);
      }
    );
  });
}

async function playAudio(filePath) {
  if (!player) {
    player = createAudioPlayer();
    connection.subscribe(player);
  }

  const resource = createAudioResource(filePath, {
    inputType: StreamType.Arbitrary,
  });

  player.play(resource);

  return new Promise((resolve, reject) => {
    player.once(AudioPlayerStatus.Idle, () => {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
      resolve();
    });

    player.once('error', error => {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
      reject(error);
    });
  });
}

client.once('ready', async () => {
  console.log('[Claudey] Ready. Connecting to voice channel...');

  const channel = await client.channels.fetch(VOICE_CHANNEL_ID);

  if (!channel || !channel.isVoiceBased()) {
    console.error('[Claudey] Invalid voice channel ID.');
    process.exit(1);
  }

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
  });

  connection.on(VoiceConnectionStatus.Ready, () => {
    console.log('[Claudey] Voice connection ready.');
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
    }
  });
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (message.content.startsWith('!claudey ')) {
    const text = message.content.slice(9);
    try {
      console.log('[Claudey] Synthesizing:', text);
      const audioFile = await synthesizeSpeech(text);
      console.log('[Claudey] Playing audio...');
      await playAudio(audioFile);
      console.log('[Claudey] Audio playback complete.');
    } catch (error) {
      console.error('[Claudey/TTS] Error:', error);
      message.reply('TTS synthesis failed. Check logs.');
    }
  }
});

client.login(DISCORD_TOKEN);
