## Goal
Make Join-Proof screenshots look like real Telegram screenshots — real channel avatar, real name, real subscriber count, real recent messages with real timestamps and views, plus proper Telegram chrome (status bar, header, service message, input/mute bar, home indicator). Then broadcast to the target as today.

## What changes

### 1. Pull real data from Telegram (server-side, per account)
On each proof run we already open an MTProto client. We'll extend the data fetch to grab everything needed to render a realistic screen:

- **Channel entity**: title, `@username`, subscriber count, description ("about"), verified flag.
- **Channel photo**: download the full-size profile photo bytes via `client.downloadProfilePhoto(entity)` and inline as base64 in the SVG. Fallback to a colored circle with initials if no photo.
- **Recent messages** (last 8): text, date (real timestamp), view count, forward header (`fwd_from`), reply header, media type (photo/video/document/poll/sticker) — media rendered as a labeled placeholder tile, not fake pixels.
- **Joining account** (for the caption / audit only): first name, username, phone. Not shown in the screenshot itself (a channel view never shows your own name), but included in the broadcast caption so you can tell which account joined.
- **Service message**: "You joined this channel" at the join timestamp we just produced.

### 2. Redesign the SVG renderer — realistic Telegram (dark theme)
Replace the current flat layout with a faithful Telegram-iOS dark-mode composition:

```text
+------------------------------------------+
| 9:41    •••• Wi-Fi   [battery]           |  <- status bar (real current time)
+------------------------------------------+
|  <  [avatar]  Channel Name  ✓            |
|               12,543 subscribers         |  <- header, condensed
+------------------------------------------+
|                                          |
|  ┌──────────────────────────────┐        |
|  │ [Forwarded from X]           │        |  <- message bubble (left-aligned, channel-style full-width)
|  │ Message text wrapped nicely  │        |
|  │ …with real newlines          │        |
|  │              9:12 AM · 4.2K👁│        |
|  └──────────────────────────────┘        |
|                                          |
|  ┌──────────────────────────────┐        |
|  │ [🖼 Photo]                    │        |  <- media placeholder tile
|  │ Optional caption text        │        |
|  │              10:04 AM · 3.8K👁│       |
|  └──────────────────────────────┘        |
|                                          |
|         ── You joined this channel ──    |  <- service pill (real join time)
|                                          |
+------------------------------------------+
|          🔔  UNMUTE                       |  <- channel footer bar
+------------------------------------------+
|                 ▬▬▬                       |  <- iOS home indicator
+------------------------------------------+
```

Details:
- Real device status-bar time from the run timestamp; correct dark-mode Telegram tokens (`#0e1621` bg, `#17212b` header/footer, `#182533` bubbles, `#5eb0ef` accent, `#7d8e9c` secondary).
- Header shows the real avatar (embedded PNG bytes → base64), title, verified check when applicable, and subscriber count formatted (`12.5K subscribers`).
- Message bubbles: proper padding, wrapping at natural width, forward header in blue, view eye + count, real time. Media types render as a rounded placeholder tile with an icon and label (`🖼 Photo`, `🎬 Video`, `📎 filename`, `📊 Poll`), plus caption below if present.
- Service message uses a rounded pill in the middle with the real join timestamp underneath.
- Only fall back to the "chat-list" style if the user explicitly picks it (already supported).

### 3. Live preview still works
The preview panel keeps rendering the SVG inline with a placeholder avatar and 3 sample messages, but uses the same new renderer so what you preview matches what the run produces.

### 4. Broadcast unchanged
Same PNG is rasterized with resvg-wasm and sent via MTProto to the target. Caption already includes the channel title; we'll append the joining account's display name so proof rows are self-describing.

## Files to change
- `src/lib/proof-render.ts` — rewrite `buildChannelViewSvg` to the realistic layout; accept `{ info, messages, avatarPng?, joinedAt, deviceTime }`; add message-type support.
- `src/lib/proof.functions.ts` — inside `runProofTask`, fetch channel photo bytes, description, richer message metadata (views, forward, media type, date), pass into the renderer; extend caption with account name.
- `src/routes/_authenticated/proof.tsx` — preview uses the new signature with a stub avatar and sample messages (photo/text mix) so the preview looks like the real thing.

## Out of scope
- Rendering actual media thumbnails (photos/videos) inside bubbles — those need per-message downloads and would slow the run a lot. Media shows as a labeled placeholder tile instead. Say the word if you want real thumbnails and I'll add it as a follow-up (with a per-message limit).
- Android skin, light theme, tablet layouts.
