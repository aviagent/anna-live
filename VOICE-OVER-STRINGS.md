# Voice-over strings — backup

Every hardcoded line Anna spoke in the lead-demo-site funnel before it was disabled.
Use this as the single source of truth when rebuilding the voice-over from scratch.

Playback is currently disabled by `VOICE_OVER_ENABLED = false` at the top of `voice.js`.
The strings still exist in the source so the form flow keeps its `await` timing — they just
don't reach TTS. Flip the flag to `true` to re-enable everything in this file at once,
or rebuild line-by-line by re-introducing each string only where you want it to play.

---

## 1. Form questions (`STEPS` array — voice.js:23-49)

| Step | Key | Line |
|------|-----|------|
| 1 | `prospect_name` | "Ok, it looks like you're ready to get started — but I didn't get your name. What should I call you?" |
| 2 | `business_name` | "Nice to meet you, {prospectName}. What's the name of your restaurant?" |
| 3 | `prospect_email` | "Let me just grab your email so we don't lose your edits — and I can send your demo to you." |
| 4 | `cuisine_type` | "And what type of cuisine does {restaurantName} serve?" |
| 5 | `menu` | "What about your menu? You can upload a photo or PDF, take a picture, or paste a link to your website. Don't have anything handy? Just tell me five items and I'll build the rest." |

## 2. Confirmation prompts (after each answer, voice.js:1199-1208)

- business_name: "{value}. Is that spelled right?"
- prospect_email: "I've got {value}. Does that look right?"
- everything else: "{value}. Does that look right?"

## 3. Retry / re-prompt lines

- "No worries — type your {field} in the box below." (after 2 failed confirms)
- "Let's try that again." (between confirm retries)
- "I didn't quite catch that — say or spell your email again. Use \"at\" for the at-sign and \"dot\" for the period."
- "That doesn't look like a valid email — try again."

## 4. Menu-ingest reactions

- PDF rejected: "I can't read PDFs directly — can you type a few menu items instead?"
- Photo OCR failed: "I had trouble reading that photo — can you type a few items instead?"
- Photo OCR success: "Found {N} items from your menu. Take a look and hit Looks good when you're ready."
- URL parse failed: "I couldn't pull menu items from that link — want to type a few instead?"
- URL parse success: "Got {N} items from your menu. Take a look and hit Looks good when you're ready."
- "No problem — type five or six items from your menu and I'll fill in the rest."
- Free-text fallback: "Got it. I'll build the full menu from those items."
- Multi-item typed: "I've got {N} items. Check them over and hit Looks good when ready."

## 5. Review screen

- "Here's everything I caught. Click any field to make changes, then hit Looks good when you're ready."

## 6. Final reveal + walkthrough

- "Okay — your AI host for {business_name} is ready. I just sent the preview to your email. Let me show you how she works."
- "Here are your {N} menu items — trained on your restaurant."
- "You can click on any item and I'll describe it. Your customers can add it straight to their order."
- Per-item description (dynamic): item name + description + price.

---

## Rebuild order suggested

1. Form questions only (steps 1-5). Verify mic + confirmation flow.
2. Confirmation prompts (very short, low risk).
3. Menu-ingest reactions (one branch at a time).
4. Final reveal narration.
5. Per-item walkthrough — reintroduce **only** if the timing won't talk over the iframe video.

That last one is what created the "I got that added you're all set" overlap — keep it deleted unless you re-orchestrate the iframe so the demo video plays AFTER Anna finishes speaking.
