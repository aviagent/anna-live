# aihostgen.aviagentics.com — what's done & what's next

## What this page is

A two-column live-build demo:

- **Left:** Kita avatar + chat. She asks 3 questions: business name → cuisine → upload menu photo.
- **Right:** the **simpledemo product** in an iframe, **always visible**, that morphs as the prospect answers (their name replaces "Stella's", their menu replaces Stella's menu).

End state: the prospect is looking at a working AI host built for their restaurant. Customize-more CTA routes to `aviagentics.com/intake-form.html?source=hostgen&session=…&business=…`.

## ✅ Done

- `index.html` — split layout (chat left, simpledemo iframe right)
- `chat.js` — flow + postMessage to iframe on each answer (live morph)
- `simpledemo-preview.html` — patched local copy of simpledemo with:
  - URL-param init (`?brand=`, `?menu=base64-json`)
  - Live `postMessage` listener (`set-brand`, `set-menu`)
  - DOM mutation observer that swaps "Stella's" → their name in real time
  - `fetch` hijack so simpledemo's menu fetch returns their items
- `style.css` — Avi Agentics navy/gold/marble, sticky split layout, mobile stacks
- Worker scaffold at `aihostgen-api/` with `/tts`, `/llm-turn`, `/ingest-menu`, `/stt`, `/health` + R2 bucket binding

## 🟡 What Kita needs to set up

### 1. New PocketBase collection (5 min in admin)

Open **http://155.138.149.147:8090/_/** → New collection → Base type:

| Field             | Type     | Notes                          |
|-------------------|----------|--------------------------------|
| `session_id`      | text     | unique index                   |
| `business_name`   | text     |                                |
| `cuisine`         | text     | the prospect's vibe answer     |
| `welcome_line`    | text     |                                |
| `menu_source`     | text     | filename or URL                |
| `menu_items`      | json     | `[{name, desc, price}, ...]`   |
| `menu_image_id`   | text     | R2 key if they uploaded a photo|
| `stage`           | text     |                                |
| `prospect_email`  | text     |                                |

**Collection name: `aihostgen_sessions`** (matches `pbCollection` in `config.js`)

API rules: list/view/create/update = `""` (public for v1). Tighten later with rate limits / session-id checks.

### 2. New Cloudflare R2 bucket

In Cloudflare dashboard → R2 → **Create bucket**:

- **Name:** `aihostgen-assets`
- **Public access:** enable for the prefix `lead-demo/` only (prospect uploads stay private if you prefer; the avatar clips need to be public)
- **Custom domain (optional):** map `aihostgen-assets.aviagentics.com` to it for nicer URLs

After creation, copy the public URL (e.g. `https://pub-xxxxxxxx.r2.dev`) into `lead-demo-site/config.js` → `r2PublicBase`.

Upload structure:
```
aihostgen-assets/
└── lead-demo/
    ├── clips/                  # Kita avatar clips after recording session
    │   ├── idle-loop.mp4
    │   ├── greet-1.mp4
    │   ├── react-name.mp4
    │   └── ...
    └── uploads/                # Prospect menu uploads (Worker writes here)
        └── <session_id>.{png,jpg,pdf}
```

### 3. Wrangler secrets + deploy

```bash
cd /Users/Kita/Desktop/claude/aihostgen-api
wrangler login
wrangler secret put CARTESIA_KEY
wrangler secret put ANTHROPIC_KEY
wrangler secret put DEEPGRAM_KEY
wrangler secret put KITA_VOICE_ID    # AFTER cloning Kita's voice — see step 4
wrangler secret put PB_URL           # http://155.138.149.147:8090
wrangler secret put PB_ADMIN_TOKEN
wrangler deploy
```

The R2 bucket binding is already declared in `wrangler.toml` — just create the bucket first.

### 4. Record + clone Kita's voice (~15 min)

~3 min of recordings, 5 segments:
- 30 s warm greeting
- 30 s reading numbers + business names ("McKinney's Pizza", "three ninety-nine a month")
- 30 s reading colors / design vocabulary
- 60 s reading the canonical demo lines (greet-1, react-name, etc.)
- 30 s of casual conversational filler

Then:
```bash
ffmpeg -i raw.m4a -ar 24000 -ac 1 kita-voice-sample.wav
curl -X POST https://api.cartesia.ai/voices/clone \
  -H "X-API-Key: $CARTESIA_KEY" \
  -F "clip=@kita-voice-sample.wav" \
  -F "name=Kita" \
  -F "language=en"
```
Save the returned `voice_id` → `wrangler secret put KITA_VOICE_ID <id>`.

⚠️ **MUST be a different voice id** than Anna's (`d8955cfc-7f79-4d3f-a460-87c56ba0c76b`) — Anna's voice is locked to Stella per project rules.

### 5. Domain wiring

- Cloudflare DNS: CNAME `aihostgen` on `aviagentics.com` → Cloudflare Pages target
- Cloudflare Pages: connect a new GitHub repo containing `lead-demo-site/`
- Worker custom domain: `api.aihostgen.aviagentics.com/*` → `aihostgen-api` Worker

## How to keep iterating locally

Preview server is wired in `.claude/launch.json` as `lead-demo-site` on port 8769:
```bash
preview_start lead-demo-site
# open http://localhost:8769
```
Add `?dev=1` to surface the dev panel.

## Local dev caveat

On `localhost`, `tts-queue.js` skips TTS entirely (the Worker isn't deployed locally and headless browser TTS stalls). When you load this in a real browser the chat is silent — that's expected. After deploying the Worker, the avatar speaks for real.
