#!/usr/bin/env node
// Extract Stella's seeded menu items + R2 imgUrls from simpledemo-preview.html
// and either (a) write them to ./food-images-seed.json for manual PB import,
// or (b) push them into PocketBase if PB_ADMIN_EMAIL + PB_ADMIN_PASS are set.
//
//   node seed-food-images.mjs                # write JSON only
//   PB_ADMIN_EMAIL=... PB_ADMIN_PASS=... node seed-food-images.mjs --push
//
// Cache key: lowercase(name).replace(/\s+/g, ' ').trim()

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, 'simpledemo-preview.html');
const OUT_JSON  = join(__dirname, 'food-images-seed.json');
const PB_URL    = process.env.PB_URL || 'http://155.138.149.147:8090';
const COLLECTION = 'food_images';

const html = await readFile(HTML_PATH, 'utf8');

// Find every {id:...,name:"...",...,imgUrl:"https://..."} block in the seed
const itemRe = /\{id:\d+,([^{}]*?imgUrl:"https:\/\/[^"]+"[^{}]*?)\}/g;
const fieldRe = (k) => new RegExp(`(?:^|,)${k}:"((?:\\\\"|[^"])*)"`);
const numFieldRe = (k) => new RegExp(`(?:^|,)${k}:(\\d+(?:\\.\\d+)?)`);

const items = [];
let m;
while ((m = itemRe.exec(html))) {
  const body = m[1];
  const name   = (body.match(fieldRe('name'))   || [])[1] || '';
  const cat    = (body.match(fieldRe('cat'))    || [])[1] || '';
  const desc   = (body.match(fieldRe('desc'))   || [])[1] || '';
  const imgUrl = (body.match(fieldRe('imgUrl')) || [])[1] || '';
  const price  = (body.match(numFieldRe('price')) || [])[1] || '';
  if (!name || !imgUrl) continue;
  // Decode \u escapes in desc
  const decoded = desc.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  items.push({
    name_key: name.toLowerCase().replace(/\s+/g, ' ').trim(),
    name,
    cat,
    desc: decoded,
    price,
    image_url: imgUrl,
    prompt: `professional food photography of ${name}`,
    cuisine: '', // Stella seeds are cuisine-agnostic — match any cuisine
  });
}

// Dedupe on name_key (keep first)
const seen = new Set();
const dedup = items.filter((it) => {
  if (seen.has(it.name_key)) return false;
  seen.add(it.name_key);
  return true;
});

await writeFile(OUT_JSON, JSON.stringify(dedup, null, 2));
console.log(`Wrote ${dedup.length} unique items to ${OUT_JSON}`);

if (process.argv.includes('--push')) {
  const email = process.env.PB_ADMIN_EMAIL;
  const pass  = process.env.PB_ADMIN_PASS;
  if (!email || !pass) {
    console.error('PB_ADMIN_EMAIL + PB_ADMIN_PASS required for --push');
    process.exit(1);
  }
  // Auth as admin
  const authRes = await fetch(`${PB_URL}/api/admins/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: email, password: pass }),
  });
  if (!authRes.ok) {
    console.error('Admin auth failed:', await authRes.text());
    process.exit(1);
  }
  const { token } = await authRes.json();
  let ok = 0, skipped = 0, failed = 0;
  for (const it of dedup) {
    // Check if already present
    const q = encodeURIComponent(`name_key="${it.name_key.replace(/"/g, '\\"')}"`);
    const existing = await fetch(`${PB_URL}/api/collections/${COLLECTION}/records?filter=${q}`, {
      headers: { Authorization: token },
    }).then(r => r.json()).catch(() => null);
    if (existing && existing.totalItems > 0) { skipped++; continue; }
    const body = {
      name_key:  it.name_key,
      cuisine:   it.cuisine,
      image_url: it.image_url,
      prompt:    it.prompt,
    };
    const r = await fetch(`${PB_URL}/api/collections/${COLLECTION}/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify(body),
    });
    if (r.ok) ok++;
    else { failed++; console.warn(it.name_key, '→', r.status, await r.text()); }
  }
  console.log(`Pushed: ${ok} created, ${skipped} skipped (already present), ${failed} failed`);
}
