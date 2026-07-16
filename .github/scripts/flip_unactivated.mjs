// Flip "unactivated" Buttondown subscribers to "regular" (active) via the API.
// The dashboard refuses this; the API allows it. Cameron's call — these are
// Instagram-sourced signups who typed their email but never clicked confirm.
//
// Env:
//   BUTTONDOWN_API_KEY  required
//   FLIP_MODE           preview (default, lists only, changes nothing) | activate
//
// Safe by default: preview never mutates. Only FLIP_MODE=activate changes anything.

const API = 'https://api.buttondown.com/v1';
const KEY = process.env.BUTTONDOWN_API_KEY;
const MODE = (process.env.FLIP_MODE || 'preview').toLowerCase();
if (!KEY) { console.error('Missing BUTTONDOWN_API_KEY'); process.exit(1); }
const H = { Authorization: `Token ${KEY}`, 'Content-Type': 'application/json' };

// 1. fetch every subscriber (paginated)
const all = [];
let url = `${API}/subscribers`;
let guard = 0;
while (url && guard++ < 100) {
  const r = await fetch(url, { headers: H });
  if (!r.ok) { console.error(`List error ${r.status}: ${await r.text()}`); process.exit(1); }
  const j = await r.json();
  for (const s of j.results || []) all.push(s);
  url = j.next || null;
}
console.log(`Total subscribers fetched: ${all.length}`);
if (!all.length) { console.error('No subscribers returned — check the API key permissions.'); process.exit(1); }

// 2. detect the status field name and find the unactivated ones
const keys = Object.keys(all[0]);
const TF = keys.includes('type') ? 'type' : (keys.includes('subscriber_type') ? 'subscriber_type' : null);
if (!TF) { console.error(`Could not find a status field. Fields: ${keys.join(', ')}`); process.exit(1); }
console.log(`Status field: "${TF}". Distribution:`);
const dist = {};
for (const s of all) dist[s[TF]] = (dist[s[TF]] || 0) + 1;
console.log('  ' + Object.entries(dist).map(([k, v]) => `${k}=${v}`).join(', '));

const unact = all.filter((s) => (s[TF] || '') === 'unactivated');
console.log(`\nUnactivated to flip: ${unact.length}`);

if (MODE !== 'activate') {
  console.log('MODE=preview — nothing changed. Re-run with FLIP_MODE=activate to flip these to regular.');
  unact.forEach((s) => console.log(`  - ${s.email}`));
  process.exit(0);
}

// 3. flip each unactivated -> regular
let ok = 0, fail = 0;
for (const s of unact) {
  const ref = encodeURIComponent(s.id || s.email);
  const r = await fetch(`${API}/subscribers/${ref}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ [TF]: 'regular' }),
  });
  if (r.ok) { ok++; console.log(`  OK  ${s.email}`); }
  else { fail++; console.error(`  FAIL ${s.email}: ${r.status} ${(await r.text()).slice(0, 200)}`); }
}
console.log(`\nRESULT: activated ${ok}/${unact.length} (${fail} failed).`);
if (fail) process.exit(1);
