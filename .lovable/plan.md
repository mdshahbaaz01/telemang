## Features to build

### 23. Bot response parser (persisted)
- **DB**: `bot_parse_rules` (id, user_id, name, bot_username, regex, field_name, unit, created_at) + `bot_parse_results` (id, user_id, rule_id, account_id, bot_username, raw_text, value_numeric, value_text, captured_at).
- **UI**: `/bot-parser` — CRUD for rules, "Run scan" button that opens the last N messages from each selected bot+account, runs regexes, stores captured values.
- **Table view**: pivot of account × field with latest value + trend.

### 24. Referral tracker (persisted)
- **DB**: `referral_links` (id, user_id, bot_username, base_link, my_ref_code, note) + `referral_joins` (id, user_id, referral_link_id, account_id, joined_at, status, last_balance_numeric, last_checked_at).
- **UI**: `/referrals` — paste a t.me/bot?start=REF link once, pick which accounts joined via it (or auto-open the link on N accounts to make them join). Table shows: account | joined? | last balance | last checked. "Refresh balances" reuses bot-parser rules.

### 29. Multi-tab account viewer (session state)
- Extend `/accounts/$id` — add a tab bar at top with pinned accounts. Click "+" → picker → opens same account viewer in a new tab within the page. Uses `useState` array + localStorage `tmpro:openAccounts`.
- Keeps one active view rendered; inactive ones stay mounted lightly (dialog list only) to preserve scroll/state. Cap at 4 open.

### 35. Analytics dashboard (persisted)
- **Source**: existing `action_runs` + `action_logs` — already logs every send/fail. Add derived aggregates.
- **DB**: no new tables needed; add a server fn `getAnalytics(range)` that aggregates from `action_logs`:
  - Messages sent per day (line chart).
  - Per-account totals + success rate.
  - Top targets (most-messaged chats).
  - Kind breakdown (broadcast/reply/forward/reaction).
- **UI**: `/analytics` — date range picker, 4 charts (recharts already in stack). CSV export.

## Files

**New migrations**
- `bot_parse_rules`, `bot_parse_results`, `referral_links`, `referral_joins` with RLS + grants.

**New server fns (`src/lib/`)**
- `bot-parser.functions.ts` — CRUD rules, `runScan`, list results.
- `referrals.functions.ts` — CRUD links, `joinFromAccounts`, `refreshBalances`, list.
- `analytics.functions.ts` — `getAnalytics({ from, to })`.

**New routes (`src/routes/_authenticated/`)**
- `bot-parser.tsx`, `referrals.tsx`, `analytics.tsx`.
- Modify `accounts.$id.tsx` for tab bar.

**Sidebar**: add 3 new links.

## Order of build (this turn)
1. DB migration for all 4 tables.
2. Server fns for parser, referrals, analytics.
3. Three new route pages (minimal but functional).
4. Multi-tab viewer on `/accounts/$id`.
5. Sidebar entries.

## Scope caveats
- Bot parser regex runs client-provided regex server-side inside a per-user try/catch — no ReDoS protection beyond a message-count cap (100 msgs × 20 rules).
- Referral auto-join uses the existing mini-app opener path (already handles `?start=` deep links).
- Analytics uses existing `action_logs` — no historical backfill needed.
- Multi-tab viewer keeps only the active tab's message stream live; others cache their last state.
