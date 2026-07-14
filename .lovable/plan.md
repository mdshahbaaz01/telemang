# Plan: Feature Requests, Onboarding, Session Manager

## 19 — Feature Request Board

**New table `feature_requests`**
- Fields: title, description, category (feature/bug/improvement), status (open/planned/in_progress/done/declined), priority (low/med/high), votes_count, user_id, owner_note.
- RLS: everyone signed-in can SELECT + INSERT own; UPDATE/DELETE own while `open`; owner can UPDATE any (status/priority/owner_note).
- Companion `feature_request_votes` (request_id, user_id UNIQUE) so users can upvote once.

**Routes / UI**
- `/feedback` (all users): submit form + list with filters (status, category), sort by votes/newest, upvote button, own-request edit.
- `/owner` gets a new "Feedback" card: pending count badge, quick triage (change status, add owner_note, set priority).

## 18 — Onboarding Checklist

**Storage**: single row in existing `user_admin_settings.notes`? Cleaner to add `onboarding_state jsonb` column with `{ dismissed, completed_steps[] }`.

**Steps (auto-detected, not manual checkboxes)**
1. Connect first Telegram account → check `telegram_accounts` count > 0.
2. Request access approved → `user_admin_settings.account_add_approved`.
3. Send first broadcast → `scheduled_broadcasts` count > 0.
4. Create first task → `join_tasks` count > 0.
5. Star a favorite / save a preset → `user_favorites` OR `action_presets` count > 0.

**UI**
- Floating card on `/dashboard` top: progress bar (x/5), collapsible, "Dismiss" persists.
- Auto-hides when all 5 done or dismissed.

## 15 — Session Manager

Supabase JS doesn't expose per-session listing to end users. Approach:

**New table `user_sessions`**
- Fields: user_id, session_key (hash of access token JTI or random on sign-in), user_agent, ip_hash, last_seen_at, created_at, revoked_at.
- Populated on sign-in via a lightweight server fn `registerSession` called from the auth flow.
- Heartbeat updates `last_seen_at` every 5 min from `_authenticated/route.tsx`.

**UI on `/reset-password` sibling `/security` (or account settings section)**
- List: device (parsed UA), IP prefix, first seen, last active, "current" badge.
- Actions:
  - **Revoke this** → mark `revoked_at`; if it's the current session → sign out.
  - **Sign out everywhere else** → `supabase.auth.signOut({ scope: 'others' })` + mark all others revoked.
- Revoked-session detection: middleware checks `session_key` against DB; if revoked → force sign-out client-side.

## Technical Details

**Migrations (single migration)**
```text
- CREATE feature_requests + votes tables + GRANTs + RLS + policies
- CREATE user_sessions + GRANTs + RLS (user sees own, owner sees all)
- ALTER user_admin_settings ADD onboarding_state jsonb DEFAULT '{}'::jsonb
- helper RPC: cast_feature_vote(request_id) SECURITY DEFINER
```

**New server fns (`src/lib/`)**
- `feedback.functions.ts`: list, create, vote, ownerUpdate
- `onboarding.functions.ts`: getState (aggregates counts + settings), dismiss
- `sessions.functions.ts`: register, heartbeat, list, revoke, revokeOthers

**New UI files**
- `src/routes/_authenticated/feedback.tsx`
- `src/routes/_authenticated/security.tsx` (session manager)
- `src/components/OnboardingChecklist.tsx` (mounted in `dashboard.tsx`)
- `src/components/OwnerFeedbackPanel.tsx` (mounted in `owner.tsx`)

**Sidebar**: add "Feedback" (all users) and "Security" (all users) entries; both in `FEATURE_KEYS` so owner can gate.

## Out of Scope
- Email notifications for status changes (can add later).
- Comment threads on feature requests.
- Geo-IP resolution beyond storing hashed IP.
