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

  // Saturday split shift: 9 AM–2 PM AND 9 PM–midnight
  if (estDay === 'Saturday') {
    return (estHour >= 9 && estHour < 14) || (estHour >= 21 && estHour < 24);
  }

  // Sunday: no work
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

  // Sunday: all social (no work, sleep whenever)
  if (estDay === 'Sunday') return true;

  // Saturday: social when NOT in a work shift and NOT in dead zone (3am-9am)
  if (estDay === 'Saturday') {
    const isWorkShift = (estHour >= 9 && estHour < 14) || (estHour >= 21 && estHour < 24);
    const inDeadZone  = (estHour >= 3 && estHour < 9);
    return !isWorkShift && !inDeadZone;
  }

  // Mon–Fri full day breakdown:
  //   3am–9am  → dead zone (sleep only)
  //   9am–3pm  → social (morning hangout before work)
  //   3pm–11pm → work
  //   11pm–3am → social (evening wind-down)
  if (estHour >= 3 && estHour < 9)  return false; // dead zone
  if (estHour >= 15 && estHour < 23) return false; // work hours
  return true; // everything else (9am-3pm morning + 11pm-3am evening) = social

}
