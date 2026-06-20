/**
 * google-maps.mjs — Leo's real-world location tools (directions + place search).
 *
 * AUTH: uses the Google Cloud SERVICE ACCOUNT (OAuth2), NOT a static API key.
 * Google recommends OAuth for server-to-server Maps Platform calls, and it's
 * safer — tokens are short-lived and minted from the key file at runtime, so
 * there's no static secret to leak. The credentials path comes from
 * GOOGLE_APPLICATION_CREDENTIALS (standard Google env var); it falls back to the
 * service-account JSON in this folder. NEVER hardcode or log the private key.
 *
 * APIs (must be enabled on the project):
 *   • Routes API        → computeRoutes  (directions, distance, ETA, steps)
 *   • Places API (New)  → places:searchText (find a place by description)
 */
import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';

const CRED_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || 'c:/KAI/tools/oracle-discord/gen-lang-client-0026175000-700e6bed29ec.json';
const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

let _auth = null;
function authClient() {
  if (_auth) return _auth;
  if (!fs.existsSync(CRED_PATH)) {
    throw new Error(`Google credentials not found at ${CRED_PATH} — set GOOGLE_APPLICATION_CREDENTIALS.`);
  }
  _auth = new GoogleAuth({ keyFile: CRED_PATH, scopes: SCOPES });
  return _auth;
}

// google-auth-library caches + auto-refreshes the access token internally.
async function bearerToken() {
  const client = await authClient().getClient();
  const t = await client.getAccessToken();
  const token = typeof t === 'string' ? t : (t && t.token);
  if (!token) throw new Error('Failed to mint Google OAuth token from the service account.');
  return token;
}

function fmtDuration(d) {
  const sec = typeof d === 'string' ? parseInt(d, 10) : (Number(d) || 0);
  if (!sec) return 'unknown';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}
function fmtDistance(m) {
  const meters = Number(m) || 0;
  const mi = meters / 1609.344, km = meters / 1000;
  return `${mi.toFixed(mi < 10 ? 1 : 0)} mi (${km.toFixed(km < 10 ? 1 : 0)} km)`;
}
function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, '').trim(); }

const TRAVEL_MODES = {
  drive: 'DRIVE', driving: 'DRIVE', car: 'DRIVE',
  walk: 'WALK', walking: 'WALK', foot: 'WALK',
  bike: 'BICYCLE', bicycle: 'BICYCLE', cycling: 'BICYCLE',
  transit: 'TRANSIT', bus: 'TRANSIT', train: 'TRANSIT',
};

/**
 * Directions via the Routes API. origin/destination are free-text addresses or
 * "lat,lng". Returns a structured result + a `full` step-by-step string and a
 * one-line `summary`.
 */
export async function getDirections(origin, destination, mode = 'drive') {
  if (!origin || !destination) return { ok: false, summary: 'Need both a start and a destination.' };
  const token = await bearerToken();
  const travelMode = TRAVEL_MODES[String(mode).toLowerCase()] || 'DRIVE';
  const body = {
    origin: { address: String(origin) },
    destination: { address: String(destination) },
    travelMode,
    computeAlternativeRoutes: false,
    units: 'IMPERIAL',
  };
  if (travelMode === 'DRIVE') body.routingPreference = 'TRAFFIC_AWARE';

  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Routes API ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const route = data.routes && data.routes[0];
  if (!route) return { ok: false, summary: `Couldn't find a ${travelMode.toLowerCase()} route from "${origin}" to "${destination}".` };

  const duration = fmtDuration(route.duration);
  const distance = fmtDistance(route.distanceMeters);
  const steps = ((route.legs && route.legs[0] && route.legs[0].steps) || [])
    .map((s) => {
      const instr = stripTags(s.navigationInstruction && s.navigationInstruction.instructions);
      if (!instr) return null;
      const d = s.distanceMeters ? ` (${fmtDistance(s.distanceMeters)})` : '';
      return `${instr}${d}`;
    })
    .filter(Boolean);

  const numbered = steps.map((s, i) => `${i + 1}. ${s}`);
  return {
    ok: true,
    origin, destination, mode: travelMode,
    duration, distance, steps,
    summary: `${travelMode.toLowerCase()} from ${origin} to ${destination}: ${distance}, about ${duration}.`,
    full: `Directions — ${travelMode.toLowerCase()} from "${origin}" to "${destination}"\nDistance: ${distance} · Time: ${duration}\n\n${numbered.join('\n')}`,
  };
}

/**
 * Place search via Places API (New) searchText. Free-text query like
 * "coffee near downtown Flint" or "Best Buy in Ann Arbor".
 */
export async function findPlace(query, { max = 5 } = {}) {
  if (!query) return { ok: false, summary: 'Need something to search for.' };
  const token = await bearerToken();
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.currentOpeningHours.openNow,places.internationalPhoneNumber,places.primaryType',
    },
    body: JSON.stringify({ textQuery: String(query), maxResultCount: Math.min(Math.max(max, 1), 10) }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Places API ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const places = (data.places || []).map((p) => ({
    name: (p.displayName && p.displayName.text) || 'Unknown',
    address: p.formattedAddress || '',
    rating: p.rating, ratings: p.userRatingCount,
    openNow: p.currentOpeningHours && p.currentOpeningHours.openNow,
    phone: p.internationalPhoneNumber || '',
    type: (p.primaryType || '').replace(/_/g, ' '),
  }));
  const line = (p) => `${p.name} — ${p.address}` +
    (p.rating ? ` (${p.rating}★${p.ratings ? `, ${p.ratings}` : ''})` : '') +
    (p.openNow === true ? ' · open now' : p.openNow === false ? ' · closed' : '');
  return {
    ok: places.length > 0,
    query, places,
    summary: places.length ? places.slice(0, 3).map(line).join('\n') : `No places found for "${query}".`,
    full: places.length ? `Places for "${query}":\n\n${places.map((p, i) => `${i + 1}. ${line(p)}${p.phone ? `\n   ${p.phone}` : ''}`).join('\n')}` : `No places found for "${query}".`,
  };
}

/**
 * Reverse geocode: turn coordinates the user read off their phone into a human
 * place — nearest street address + coarse area (city, state). Uses the Geocoding
 * API, which is API-KEY based (GOOGLE_API_KEY), NOT the service account. Lets Leo
 * CONFIRM where someone is ("okay, you're near Main & 5th in Flint") and store it
 * as their last_location, instead of blindly routing from raw numbers.
 */
export async function reverseGeocode(lat, lng) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, summary: 'Reverse geocoding needs GOOGLE_API_KEY set in .env.' };
  // Accept a single "lat,lng" string in the first arg too.
  if (lng == null && typeof lat === 'string' && lat.includes(',')) {
    const [a, b] = lat.split(',').map((s) => s.trim());
    lat = a; lng = b;
  }
  const latNum = Number(lat), lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return { ok: false, summary: 'Need valid coordinates like "42.97, -83.69".' };
  }
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latNum},${lngNum}&key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Geocoding API ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.status !== 'OK' || !data.results || !data.results.length) {
    return { ok: false, summary: `No address found for ${latNum}, ${lngNum} (status: ${data.status}${data.error_message ? ' — ' + data.error_message : ''}).` };
  }
  const best = data.results[0];
  const address = best.formatted_address || '';
  const comp = (type) => {
    for (const r of data.results) {
      const c = (r.address_components || []).find((x) => (x.types || []).includes(type));
      if (c) return c.long_name;
    }
    return null;
  };
  const city = comp('locality') || comp('postal_town') || comp('administrative_area_level_2');
  const state = comp('administrative_area_level_1');
  const area = [city, state].filter(Boolean).join(', ');
  return {
    ok: true,
    lat: latNum, lng: lngNum, address, area,
    summary: address ? `You're at/near ${address}${area && !address.includes(area) ? ` (${area})` : ''}.` : `Near ${area || `${latNum}, ${lngNum}`}.`,
    full: `Coordinates ${latNum}, ${lngNum} → ${address}${area ? `\nArea: ${area}` : ''}`,
  };
}

function _parseCoords(lat, lng) {
  if (lng == null && typeof lat === 'string' && lat.includes(',')) {
    const [a, b] = lat.split(',').map((s) => s.trim()); lat = a; lng = b;
  }
  const la = Number(lat), lo = Number(lng);
  return (Number.isFinite(la) && Number.isFinite(lo)) ? [la, lo] : null;
}

/** Elevation (height above sea level) at a coordinate — "am I on a hill?" */
export async function getElevation(lat, lng) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, summary: 'Elevation needs GOOGLE_API_KEY in .env.' };
  const c = _parseCoords(lat, lng);
  if (!c) return { ok: false, summary: 'Need valid coordinates like "42.97, -83.69".' };
  const res = await fetch(`https://maps.googleapis.com/maps/api/elevation/json?locations=${c[0]},${c[1]}&key=${key}`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Elevation API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results || !data.results.length) return { ok: false, summary: `No elevation (status: ${data.status}).` };
  const m = data.results[0].elevation, ft = m * 3.28084;
  return { ok: true, meters: m, feet: ft, summary: `Elevation: ${ft.toFixed(0)} ft (${m.toFixed(0)} m) above sea level.` };
}

/** Time zone + current LOCAL time at a coordinate — is it day or night there? */
export async function getTimeZone(lat, lng) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, summary: 'Time Zone needs GOOGLE_API_KEY in .env.' };
  const c = _parseCoords(lat, lng);
  if (!c) return { ok: false, summary: 'Need valid coordinates.' };
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(`https://maps.googleapis.com/maps/api/timezone/json?location=${c[0]},${c[1]}&timestamp=${ts}&key=${key}`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Time Zone API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
  if (data.status !== 'OK') return { ok: false, summary: `No time zone (status: ${data.status}).` };
  const local = new Date((ts + (data.rawOffset || 0) + (data.dstOffset || 0)) * 1000);
  const hh = String(local.getUTCHours()).padStart(2, '0'), mm = String(local.getUTCMinutes()).padStart(2, '0');
  return { ok: true, timeZoneId: data.timeZoneId, name: data.timeZoneName, localTime: `${hh}:${mm}`,
    summary: `${data.timeZoneName} (${data.timeZoneId}) — their local time is about ${hh}:${mm}.` };
}

/** Satellite (top-down) Static-Map image URL. The URL carries the API key, so
 *  callers must fetch it server-side and attach the bytes — never post the URL. */
export async function getSatelliteUrl(lat, lng, zoom = 17) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, summary: 'Satellite view needs GOOGLE_API_KEY in .env.' };
  const c = _parseCoords(lat, lng);
  if (!c) return { ok: false, summary: 'Need valid coordinates.' };
  const z = Math.min(Math.max(Number(zoom) || 17, 1), 20);
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${c[0]},${c[1]}&zoom=${z}&size=640x480&maptype=satellite&markers=color:red%7C${c[0]},${c[1]}&key=${key}`;
  return { ok: true, url, lat: c[0], lng: c[1], zoom: z, summary: `Satellite view of ${c[0]}, ${c[1]} (zoom ${z}).` };
}

/** Ground-level Street View image at a coordinate (key-bearing URL — fetch it
 *  server-side, never post it). Checks metadata first: remote/forest spots have
 *  no imagery. heading 0-360 = which way the camera faces. */
export async function getStreetViewUrl(lat, lng, heading) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, summary: 'Street View needs GOOGLE_API_KEY in .env.' };
  const c = _parseCoords(lat, lng);
  if (!c) return { ok: false, summary: 'Need valid coordinates.' };
  const meta = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${c[0]},${c[1]}&key=${key}`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json()).catch(() => null);
  if (!meta || meta.status !== 'OK') return { ok: false, summary: `No street-level imagery there (${meta ? meta.status : 'lookup failed'}) — probably too remote.` };
  const h = (heading != null && Number.isFinite(Number(heading))) ? `&heading=${Number(heading)}` : '';
  const url = `https://maps.googleapis.com/maps/api/streetview?size=640x480&location=${c[0]},${c[1]}${h}&fov=90&key=${key}`;
  return { ok: true, url, lat: c[0], lng: c[1], summary: `Street-level view of ${c[0]}, ${c[1]}.` };
}

/** Cinematic 3D aerial flyover video for an ADDRESS (Aerial View API). Renders
 *  ASYNCHRONOUSLY: returns a playable MP4 link if one's ready, otherwise kicks
 *  off a render and reports it's coming. The video URIs are signed (no API key),
 *  so the link is safe to share. */
export async function getAerialView(address) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, summary: 'Aerial View needs GOOGLE_API_KEY in .env.' };
  const addr = String(address || '').trim();
  if (!addr) return { ok: false, summary: 'Need an address for the aerial view.' };
  const look = await fetch(`https://aerialview.googleapis.com/v1/videos:lookupVideo?key=${key}&address=${encodeURIComponent(addr)}`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null);
  if (look && look.state === 'ACTIVE' && look.uris) {
    const slot = look.uris.MP4_MEDIUM || look.uris.MP4_HIGH || look.uris.MP4_LOW || Object.values(look.uris)[0] || {};
    const uri = slot.landscapeUri || slot.portraitUri;
    if (uri) return { ok: true, ready: true, uri, summary: `Aerial flyover of ${addr} is ready.` };
  }
  // PROCESSING or not found → request a render so it'll be ready next time.
  await fetch(`https://aerialview.googleapis.com/v1/videos:renderVideo?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: addr }), signal: AbortSignal.timeout(15000),
  }).catch(() => {});
  return { ok: true, ready: false, summary: `Aerial flyover of ${addr} is rendering — it takes a little while; ask again in a minute.` };
}

/** Current weather conditions at a coordinate (Weather API, key-based). Schema is
 *  newish, so parsed defensively with fallbacks. */
export async function getWeather(lat, lng) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, summary: 'Weather needs GOOGLE_API_KEY in .env.' };
  const c = _parseCoords(lat, lng);
  if (!c) return { ok: false, summary: 'Need valid coordinates.' };
  const res = await fetch(`https://weather.googleapis.com/v1/currentConditions:lookup?key=${key}&location.latitude=${c[0]}&location.longitude=${c[1]}`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Weather API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const d = await res.json();
  const cond = (d.weatherCondition && (d.weatherCondition.description && d.weatherCondition.description.text)) || (d.weatherCondition && d.weatherCondition.type) || 'unknown conditions';
  const unit = (d.temperature && d.temperature.unit) || 'CELSIUS';
  const toF = (v) => (v == null ? null : (unit === 'CELSIUS' ? v * 9 / 5 + 32 : v));
  const tempF = toF(d.temperature && d.temperature.degrees);
  const feelsF = toF(d.feelsLikeTemperature && d.feelsLikeTemperature.degrees);
  const hum = d.relativeHumidity;
  const wind = d.wind && d.wind.speed && d.wind.speed.value;
  const parts = [String(cond)];
  if (tempF != null) parts.push(`${Math.round(tempF)}°F`);
  if (feelsF != null && Math.round(feelsF) !== Math.round(tempF ?? feelsF)) parts.push(`feels like ${Math.round(feelsF)}°F`);
  if (hum != null) parts.push(`${hum}% humidity`);
  if (wind != null) parts.push(`wind ${Math.round(wind)} ${(d.wind.speed.unit || 'km/h')}`);
  return { ok: true, raw: d, summary: parts.join(', ') + '.' };
}

/** Validate + normalize a street address (Address Validation API, key-based). */
export async function validateAddress(address) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, summary: 'Address validation needs GOOGLE_API_KEY in .env.' };
  const addr = String(address || '').trim();
  if (!addr) return { ok: false, summary: 'Need an address to validate.' };
  const res = await fetch(`https://addressvalidation.googleapis.com/v1:validateAddress?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: { addressLines: [addr] } }), signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Address Validation API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const d = await res.json();
  const r = d.result || {};
  const formatted = (r.address && r.address.formattedAddress) || addr;
  const verdict = r.verdict || {};
  const complete = verdict.addressComplete === true;
  const unconfirmed = verdict.hasUnconfirmedComponents === true;
  return {
    ok: true, raw: d, formatted, complete, unconfirmed,
    summary: (complete && !unconfirmed)
      ? `Validated: "${formatted}".`
      : `Best match: "${formatted}"${unconfirmed ? ' (some parts unconfirmed — double-check it)' : ''}${!complete ? ' (looks incomplete)' : ''}.`,
  };
}

/** Sanity check that we can authenticate (used by a status/diagnostic). */
export async function pingAuth() {
  try { await bearerToken(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
