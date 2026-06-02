/**
 * auto-ingest.mjs
 * 
 * Runs in the background and waits until 9:05 AM EST to automatically
 * trigger KAI's bulk ingestion process.
 */
import { exec } from 'child_process';

const TARGET_HOUR = 9;
const TARGET_MINUTE = 5;

console.log(`[Auto-Ingest] Watcher started. Waiting for ${TARGET_HOUR}:0${TARGET_MINUTE} AM to ingest harvest.jsonl...`);

setInterval(() => {
  const now = new Date();
  
  // Checking local time (Assuming the PC is in EST as per user context)
  if (now.getHours() === TARGET_HOUR && now.getMinutes() === TARGET_MINUTE) {
    console.log(`\n[Auto-Ingest] Time reached! Triggering KAI bulk ingestion...`);
    
    // Execute the cargo run command for bulk-ingest
    const child = exec('cargo run --release --bin kai -- --bulk-ingest=C:\\KAI\\data\\harvest.jsonl', { cwd: 'C:\\KAI' });
    
    child.stdout.on('data', (data) => process.stdout.write(data));
    child.stderr.on('data', (data) => process.stderr.write(data));
    
    child.on('close', (code) => {
      console.log(`[Auto-Ingest] Process finished with exit code ${code}. KAI is fully updated!`);
      process.exit(0);
    });
  }
}, 60000); // Check every minute
