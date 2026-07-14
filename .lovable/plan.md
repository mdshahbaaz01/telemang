# Multi-user mode with restricted access

Naye users sign-up karke sirf apna Telegram account connect kar sakenge aur **Broadcast + Scheduled Broadcast** hi use kar sakenge. Aap (admin) ka access unchanged rahega — sab kuch mil raha hai jaise pehle.

## Access model

- **Admin** (aap): sab pages, sab accounts (owner panel bhi)
- **User** (naye sign-ups, default role): sirf 4 pages
  - Dashboard (limited — apne accounts + apne broadcasts ke stats)
  - Accounts (apne Telegram accounts add/connect/manage)
  - Broadcast (immediate)
  - Scheduled Broadcast (schedule + history + reuse)

Baaki sab pages (Bot Flow, Cleanup, Actions non-broadcast, Bulk Mix, Owner, Captcha, etc.) users ke liye hidden aur route-level pe blocked.

## What gets built

**1. Role gating (server-side, hard block)**
- Ek naya helper `requireBroadcastAccess` — server functions ke andar check karega ki user `admin` ya `user` hai (dono allowed for broadcast). Non-broadcast server fns pe `requireAdmin` helper add karenge jo `admin` na hone pe 403 dega.
- Ye critical hai — sirf UI hide karne se enough nahi, warna user URL type karke bhi access le lega.

**2. Sidebar filtering**
- `getMyRole()` (already exists) se `isAdmin` fetch → non-admin users ko sidebar me sirf 4 items dikhenge (Dashboard, Accounts, Broadcast, Scheduled).
- Drag-drop reorder unchanged for allowed items.

**3. Route-level guards**
- Har restricted route (`bot-flow`, `cleanup`, `owner`, etc.) ke `beforeLoad` me role check → non-admin ho to `/dashboard` pe redirect.
- Allowed routes: `/dashboard`, `/accounts/*`, `/actions?tab=broadcast`, aur ek naya `/scheduled` route (currently scheduled broadcast `actions` ke andar hai — user ke liye clean dedicated page banayenge, admin ke liye dono jagah kaam karega).

**4. Dashboard scoping**
- Already `user_id` scoped hai queries me (RLS aap ke design me hai). Confirm karke user-view me sirf apna data dikhega.

**5. Broadcast page cleanup for users**
- `/actions` page pe non-admin ko sirf "Broadcast" tab dikhega (Actions/Forward/React/Comment tabs hidden). Admin ke liye sab tabs jaise pehle.

**6. Signup flow unchanged**
- Existing `bootstrap_role_on_signup` trigger already naye users ko `'user'` role deta hai (pehla user hi admin banta hai). Sign-up + email confirm + login flow already ready hai — koi change nahi.
- Naya user login → seedha dashboard → Accounts page pe jaake apna phone connect karega (existing add-account flow) → Broadcast start.

## Not doing (out of scope, batao agar chahiye)

- User ke Telegram accounts ka limit (e.g. max 5 per user) — abhi unlimited
- Payment/subscription
- Email verification enforcement (already Supabase default)
- Separate branded landing page for users

## Technical notes

- New file: `src/lib/access.functions.ts` exporting `requireAdmin(context)` and `requireBroadcastAccess(context)` helpers used inside handlers.
- Modify: `src/components/app-sidebar.tsx` — role fetch + filter items array.
- Modify: `src/routes/_authenticated/route.tsx` — expose `role` in route context via loader so children ka `beforeLoad` sync check kar sake.
- Add `beforeLoad` role check to: `bot-flow`, `cleanup`, `actions` (non-broadcast tabs), `bulk-mix`, `bulk-plus`, `bot-parser`, `captcha`, `owner`, `recipes`, `watchlists`, `stealth`, `join-pacing`, `health`, `alerts`, `buttons`, `profile-updater`, `search`, `workspace`, `media`, `referrals`, `analytics`, `tasks/*`, `groups/*`.
- Add admin-only enforcement inside server fns of those pages (defense-in-depth).
- Broadcast + scheduled server fns get `requireBroadcastAccess` (both roles pass).

Approve karo to build shuru karta hoon. Ya koi tweak chahiye (jaise user ko 1-2 aur pages dena, ya account limit lagana), bata do.
