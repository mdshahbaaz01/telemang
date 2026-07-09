## Full mini-Telegram viewer per account

A real Telegram-like page for any account. Two-pane layout (chats list + open chat), live updates over SSE, send / reply / react, and media rendering.

### Entry points

- Owner Panel & Dashboard: account cards become clickable → `/accounts/:id`.
- A new file route `src/routes/_authenticated/accounts.$id.tsx` renders the viewer full-page.
- Card click uses `Link to="/accounts/$id"` (regular in-app navigation). "Open in new tab" is available via right-click / middle-click since it's a real route.

### Layout

```text
┌────────────────────────────────────────────────────────────┐
│  Header: account name · phone · status · [Back]            │
├──────────────┬─────────────────────────────────────────────┤
│  Dialogs     │  Chat header (title, subtitle, avatar)      │
│  ────────    ├─────────────────────────────────────────────┤
│  🔍 search   │  Messages (virtualised, oldest→newest)      │
│  [Pinned]    │  ● typing indicators                        │
│  chat 1  •3  │  ● live inserts / edits / deletes           │
│  chat 2      │  ● media: photos, videos, voice, docs       │
│  chat 3      │  ● reactions bar                            │
│  …           ├─────────────────────────────────────────────┤
│              │  Reply-to preview · composer · send · 😀    │
└──────────────┴─────────────────────────────────────────────┘
```

### Server functions (in `src/lib/tg-viewer.functions.ts`)

All require `requireSupabaseAuth` + admin check + the account belongs to a user the viewer can access (same policy as Owner Panel).

| Function            | Purpose                                                                        |
|---------------------|--------------------------------------------------------------------------------|
| `listDialogs`       | Return top N dialogs (pinned first): id, title, avatar, last message, unread   |
| `getHistory`        | Paginated messages for a peer (offsetId cursor, limit 50)                      |
| `getPeerInfo`       | Title, subtitle (members, last-seen), photo, is-channel/user/group             |
| `resolveMedia`      | Signed short-lived URL for a photo/document/thumbnail (proxied via server)     |
| `sendMessageAs`     | Send text/reply; optional attachment upload                                    |
| `sendReactionAs`    | Toggle reaction on a msg                                                       |
| `markRead`          | ReadHistory for a peer                                                         |
| `deleteMessagesAs`  | Delete for me / everyone                                                       |

### Live updates (SSE)

New server route `src/routes/api/public/tg-updates-stream.ts` (secured with bearer token from client):

- Opens the account's MTProto client once, subscribes to `updates` (new message, edited, deleted, typing, read).
- Streams events as SSE frames the viewer consumes: `message.new`, `message.edited`, `message.deleted`, `typing`, `read`.
- Client tears down on unmount; server closes MTProto on abort.
- Uses per-account singleton via a small in-memory ref-counted registry so multiple viewers of the same account share one MTProto socket.

### Media

- Photos/thumbs downloaded server-side via `client.downloadMedia`, cached in Supabase Storage `chat-media` bucket (private), served through short-lived signed URLs.
- Voice notes → `<audio>`; videos → `<video>` with poster; documents → download link with filename + size + icon.

### UI components (new)

```
src/components/tg/
  DialogList.tsx        - virtualised list, unread badges, active state
  ChatHeader.tsx        - avatar, title, subtitle (typing / online)
  MessageList.tsx       - virtualised, day dividers, grouped bubbles
  MessageBubble.tsx     - text, reply preview, reactions, media, edited/time
  Composer.tsx          - textarea, emoji, attach, reply-to preview
  MediaViewer.tsx       - fullscreen image/video overlay
  Avatar.tsx            - initials fallback + cached photo
```

Style: Telegram-like density; dark-mode aware; user's bubble on right (primary tint), theirs on left (muted card). No colored assistant bubbles rule doesn't apply — this is a chat CLIENT, not an AI chat.

### Data flow

1. Route loader is thin — auth check only. Data comes via TanStack Query.
2. `useQuery(["dialogs", accountId])` calls `listDialogs`.
3. Selecting a dialog updates a `?peer=...` search param; another `useQuery(["history", accountId, peer])` loads history.
4. SSE stream started on mount; on each event, `queryClient.setQueryData` patches the affected list (append/replace/remove) — no full refetch.
5. Sending calls `sendMessageAs` then optimistically appends a message; the SSE echo reconciles the real ID.

### Safety / limits

- Only account owner (or shared-admin per existing Owner Panel rules) can open.
- Rate-limit `sendMessageAs` on server (5/s per account).
- Respect `paused_until` — read is allowed, writes blocked with a toast when paused.
- `resolveMedia` size ceiling (25 MB) + mime-type allowlist.

### Ship order (all in this pass)

1. Server fns (`listDialogs`, `getHistory`, `getPeerInfo`, `sendMessageAs`, `markRead`, `sendReactionAs`, `resolveMedia`).
2. SSE update route + tiny client hook `useTgUpdates(accountId)`.
3. `chat-media` storage bucket + policies.
4. `accounts.$id.tsx` route + components above.
5. Wire clickable account cards on Owner Panel & Dashboard.
6. Add "Open account" affordance to sidebar quick-access recent list.

### Out of scope (can add later)

- Sending albums (2–10 grouped media) from viewer — for now single attachment per message.
- Secret chats / voice/video calls.
- Message search inside a chat (dialog search only for v1).
- Sticker packs UI (custom emoji reactions supported; sending stickers not).

Approve to build.