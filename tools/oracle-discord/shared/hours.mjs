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

  // No work on weekends
  if (estDay === 'Saturday' || estDay === 'Sunday') return false;

  // Working hours: 9 AM to 2 PM EST (14:00)
  if (estHour >= 9 && estHour < 14) {
    return true;
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

  // Sunday is full social day from 9 AM to 9 PM
  if (estDay === 'Sunday' && estHour >= 9 && estHour < 21) {
    return true;
  }
  return false;
}
