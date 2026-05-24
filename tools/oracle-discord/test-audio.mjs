import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import { Readable } from 'stream';

async function test() {
  console.log("Generating audio with edge-tts...");
  const pregeneratedMp3 = await new Promise((resolveBuffer) => {
    const edge = spawn('edge-tts', ['--text', 'This is a test of the emergency broadcast system.', '--voice', 'en-US-ChristopherNeural']);
    const chunks = [];
    edge.stdout.on('data', d => chunks.push(d));
    edge.stderr.on('data', d => console.log('EDGE STDERR:', d.toString()));
    edge.on('close', () => resolveBuffer(Buffer.concat(chunks)));
  });

  console.log(`Audio generated! Buffer size: ${pregeneratedMp3.length} bytes.`);

  console.log("Transcoding with FFmpeg using Readable.from...");
  const ffmpeg = spawn(ffmpegPath, [
    '-i', 'pipe:0',
    '-af', 'volume=2.0',
    '-c:a', 'libopus', '-b:a', '96k', '-f', 'opus', 'test_out.opus'
  ]);

  ffmpeg.stderr.on('data', d => console.log('FFMPEG:', d.toString()));
  
  // Use stream piping instead of write()
  Readable.from(pregeneratedMp3).pipe(ffmpeg.stdin);

  ffmpeg.on('close', (code) => {
    console.log(`FFmpeg exited with code ${code}`);
  });
}

test();
