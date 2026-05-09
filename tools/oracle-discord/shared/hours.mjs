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
    return (estHour >= 15 && estHour < 23);
  }

  // Saturday split shift: 10 AM–2 PM AND 9 PM–midnight
  if (estDay === 'Saturday') {
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

  if (estDay === 'Sunday') return true;

  if (estDay === 'Saturday') {
    const isWorkShift = (estHour >= 10 && estHour < 14) || (estHour >= 21 && estHour < 24);
    const inDeadZone  = (estHour >= 3 && estHour < 9);
    return !isWorkShift && !inDeadZone;
  }

  // Mon-Fri: 
  // 3am-9am: Dead Zone
  // 3pm-11pm: Work
  // The rest: Social
  if (estHour >= 3 && estHour < 9)  return false; 
  if (estHour >= 15 && estHour < 23) return false; 
  return true;
}
