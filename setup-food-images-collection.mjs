#!/usr/bin/env node
// One-time setup: create food_images collection in PocketBase + seed with Stella items.
// Run: node setup-food-images-collection.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PB   = 'http://155.138.149.147:8090';
const COLL = 'food_images';

// ── Admin auth ────────────────────────────────────────────────────────────────
const authRes = await fetch(`${PB}/api/collections/_superusers/auth-with-password`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identity: 'bridge@kita.local', password: 'uiQ0Dhb71jY7TrNMG13uMz7x' }),
});
if (!authRes.ok) { console.error('Admin auth failed:', await authRes.text()); process.exit(1); }
const { token } = await authRes.json();
console.log('✓ Admin auth OK');

const H = { 'Content-Type': 'application/json', Authorization: token };

// ── Create collection if missing ──────────────────────────────────────────────
const existing = await fetch(`${PB}/api/collections/${COLL}`, { headers: H });
if (existing.ok) {
  console.log(`✓ Collection '${COLL}' already exists — skipping create`);
} else {
  const schema = {
    name: COLL,
    type: 'base',
    fields: [
      { name: 'name_key',  type: 'text',    required: true  },
      { name: 'cuisine',   type: 'text',    required: false },
      { name: 'image_url', type: 'url',     required: false },
      { name: 'video_url', type: 'url',     required: false },
      { name: 'prompt',    type: 'text',    required: false },
    ],
    // Public read, public create (for client-side writes), no delete
    listRule:   '',
    viewRule:   '',
    createRule: '',
    updateRule: null,
    deleteRule: null,
    indexes: [`CREATE INDEX idx_food_images_name_key ON ${COLL} (name_key)`],
  };
  const r = await fetch(`${PB}/api/collections`, {
    method: 'POST', headers: H, body: JSON.stringify(schema),
  });
  if (!r.ok) { console.error('Create collection failed:', await r.text()); process.exit(1); }
  console.log(`✓ Created collection '${COLL}'`);
}

// ── Seed from food-images-seed.json ──────────────────────────────────────────
const seedPath = join(__dirname, 'food-images-seed.json');
const seeds = JSON.parse(await readFile(seedPath, 'utf8'));
console.log(`Seeding ${seeds.length} items…`);

let created = 0, skipped = 0, failed = 0;
for (const it of seeds) {
  const q = encodeURIComponent(`name_key="${it.name_key.replace(/"/g, '\\"')}"`);
  const check = await fetch(`${PB}/api/collections/${COLL}/records?filter=${q}&perPage=1`, { headers: H });
  const data  = await check.json();
  if (data.totalItems > 0) { skipped++; process.stdout.write('.'); continue; }

  const r = await fetch(`${PB}/api/collections/${COLL}/records`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name_key:  it.name_key,
      cuisine:   '',
      image_url: it.image_url,
      video_url: '',
      prompt:    it.prompt,
    }),
  });
  if (r.ok) { created++; process.stdout.write('+'); }
  else { failed++; console.warn(`\nFailed ${it.name_key}:`, await r.text()); }
}
console.log(`\n✓ Done — ${created} created, ${skipped} skipped, ${failed} failed`);
