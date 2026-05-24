import fs from 'fs';

const OVERRIDE_PATH = 'c:/KAI/tools/oracle-discord/state/late_night_override.flag';

export function isWorkingHours() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    weekday: 'long',
    hour12: false
  });
  
  const parts = formatter.formatToParts(now);
  const estHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const estDay = parts.find(p => p.type === 'weekday').value;

  // Monday–Friday: 3:00 PM – 11:00 PM EST (15–23)
  if (estDay !== 'Saturday' && estDay !== 'Sunday') {
    if (fs.existsSync(OVERRIDE_PATH)) return true; // LATE NIGHT OVERRIDE
    return (estHour >= 15 && estHour < 23);
  }

  // Saturday split shift: 10 AM–2 PM AND 9 PM–midnight
  if (estDay === 'Saturday') {
    if (fs.existsSync(OVERRIDE_PATH)) return true; // LATE NIGHT OVERRIDE
    return (estHour >= 10 && estHour < 14) || (estHour >= 21 && estHour < 24);
  }

  return false;
}

export function isSocialHours() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    weekday: 'long',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const estHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const estDay = parts.find(p => p.type === 'weekday').value;

  // LATE NIGHT OVERRIDE: If the flag exists, ignore the 3am-9am Dead Zone
  const INTERACTION_PATH = 'c:/KAI/tools/oracle-discord/state/user_interaction.flag';
  let isInteracting = false;
  if (fs.existsSync(INTERACTION_PATH)) {
    try {
      const stats = fs.statSync(INTERACTION_PATH);
      if (Date.now() - stats.mtimeMs < 14400000) isInteracting = true; // 4 hours
    } catch (e) {}
  }

  if (fs.existsSync(OVERRIDE_PATH) || isInteracting) {
    return true; 
  }

  if (estDay === 'Sunday') return true;

  if (estDay === 'Saturday') {
    const isWorkShift = (estHour >= 10 && estHour < 14) || (estHour >= 21 && estHour < 24);
    return !isWorkShift;
  }

  // Mon-Fri: 
  if (estHour >= 15 && estHour < 23) return false; 
  return true;
}

/**
 * Returns a string directive if a state change is approaching within the next 20 mins.
 */
export function getCircadianAnticipation() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const min = parseInt(parts.find(p => p.type === 'minute').value, 10);

  // Transition to WORK (15:00)
  if (hour === 14 && min >= 40) {
    return `[TRANSITION] It is ${hour}:${min}. Your work shift starts in ${60-min} minutes. Start wrapping up the social chat and mention you have to head to the department soon.`;
  }
  // Transition to SLEEP (23:00 / 03:00)
  if (hour === 22 && min >= 40) {
    return `[TRANSITION] It is ${hour}:${min}. Bedtime is in ${60-min} minutes. Start saying your goodnights.`;
  }
  // Transition to END OF WORK (23:00)
  if (hour === 22 && min >= 50) {
    return `[TRANSITION] Work shift is almost over. Prepare your final reports.`;
  }
  
  return "";
}
