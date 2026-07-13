# Refactoring & System Optimization Plan

A phased plan to reduce technical debt, improve runtime performance, and harden reliability across the Telegram Management app — without changing user-facing behavior.

---

## Phase 1 — Audit & Baseline (day 1)

**Goal:** know what we have before we change it.

1. Generate a dependency map: `src/lib/*.functions.ts`, `*.server.ts`, `routes/api/public/*`, and their callers.
2. Run bundle analysis (`vite build --report`) to find heaviest routes/components.
3. Capture Supabase slow queries (`supabase--slow_queries`) and DB linter warnings.
4. Enable structured logging counters for: FloodWait, join failures, task heartbeats, captcha events.
5. Snapshot current metrics: build size per route, TTI on /workspace, avg task latency, error rate.

**Deliverable:** `.lovable/audit-baseline.md` with numbers we'll compare against.

---

## Phase 2 — Code Structure Refactor (days 2–4)

**Goal:** consistent, discoverable modules.

1. **Standardize server module split**
   - `*.functions.ts` — only `createServerFn` wrappers + validation.
   - `*.server.ts` — pure server helpers (no `createServerFn`).
   - Move stray logic out of route files.
2. **Centralize Telegram primitives** into `src/lib/telegram/`:
   - `client.server.ts` (GramJS session build)
   - `join.server.ts` (peek → import → verify — already exists, consolidate callers)
   - `resolve.server.ts` (target resolver)
   - `send.server.ts` (broadcast/DM/edit unified sender)
   - `errors.server.ts` (FloodWait parsing, retry classification)
3. **Delete dead code**: unused components, orphan hooks, duplicated dialogs (Reuse/Schedule share a dialog now).
4. **Type hardening**: replace `any` in task payloads with discriminated unions per task type.
5. **Component boundaries**: split any file >400 lines (workspace, bot-flow, broadcast).

---

## Phase 3 — Data Layer Optimization (days 5–6)

1. **Indexes** on hot paths:
   - `tasks(status, updated_at)` for resume-stuck scan
   - `join_attempts(account_id, channel_id, created_at)`
   - `join_cache(account_id, target_key)` unique
   - `bot_flow_history(created_at desc)`
   - `broadcast_targets(broadcast_id, status)`
2. **RLS review**: audit every public table for correct grants; remove any anon SELECT not needed.
3. **Retention jobs** (pg_cron): purge `join_attempts`, `inline_button_clicks`, `task_logs` older than 30 days.
4. **Payload slimming**: store large logs in `text` column separate from row hot fields; select subset by default.
5. **Realtime**: replace polling with Supabase channels for task status, join progress, captcha log.

---

## Phase 4 — Runtime Performance (days 7–8)

1. **Route-level code splitting**: lazy-load `/workspace`, `/captcha`, `/bot-flow` heavy tabs.
2. **Query cache**: set stable `queryKey` + `staleTime` on account lists, groups, presets.
3. **Virtualize** long lists (targets picker, member scan, task history) via `@tanstack/react-virtual`.
4. **Memoize** expensive selectors (PastedTargetsBox classifier, spintax expander).
5. **Debounce** all filter inputs (300 ms) and TargetsPicker search.
6. **Worker offload**: move spintax expansion and target dedup to a Web Worker.

---

## Phase 5 — Telegram Executor Hardening (days 9–11)

1. **Unified execution loop** with pluggable steps: `resolve → precheck → act → verify → log`.
2. **Adaptive pacing**: per-account rolling FloodWait window; back off globally when hit-rate > threshold.
3. **Sequential-per-account, parallel-across-accounts** enforced in one scheduler (remove ad-hoc loops).
4. **Idempotency keys** on broadcast/DM sends to survive retries without dupes.
5. **Heartbeat + resume**: promote existing `resume-stuck` to a Postgres advisory-lock scheduler.
6. **Circuit breaker** per account: auto-pause after N consecutive auth/deactivated errors.

---

## Phase 6 — Observability (day 12)

1. **Structured log schema** (`level, task_id, account_id, target, path, latency_ms, error_code`).
2. **Log viewer** at `/logs` with filters + tail mode (reuses captcha log UI).
3. **Metrics dashboard**: success rate, FloodWait/min, join verify rate, captcha solve rate.
4. **Client error boundary** already exists — extend `logClientError` to hit a `/api/public/client-errors` sink.

---

## Phase 7 — UX & Accessibility Pass (day 13)

1. Keyboard shortcuts (`?` help panel, `g d` = dashboard, `g w` = workspace, `n` = new task).
2. ARIA labels on icon buttons; focus rings audit.
3. Skeleton loaders replace spinners on primary lists.
4. Empty states with actionable CTAs everywhere.

---

## Phase 8 — Security Sweep (day 14)

1. Run `security--run_security_scan`; fix all High/Medium.
2. Audit `/api/public/*` — every handler must verify `CRON_SECRET` or signature.
3. Move any lingering secrets from code to `secrets--add_secret`.
4. Rotate anon-key usages that should be authenticated.

---

## Phase 9 — Verification & Rollout (day 15)

1. Re-measure Phase 1 metrics; require ≥30% bundle reduction on top 3 routes, ≥50% fewer FloodWaits, zero orphan `.server` imports in client graph.
2. Playwright smoke: login → create task → run → verify → cleanup.
3. Publish and monitor 24h.

---

## Non-Goals

- No new user-facing features.
- No visual redesign (Noir & Gold / Paper & Ink stays).
- No swap of GramJS or Supabase.

---

## Risks & Mitigation

| Risk | Mitigation |
|---|---|
| Executor refactor breaks live tasks | Ship behind `executor_v2` flag; canary 10% of tasks |
| Index migrations lock tables | Use small tables first; schedule big ones off-peak |
| Realtime channel limits | Fall back to 5 s polling if channel count > quota |

Proceed phase by phase; each phase ends with a green build, passing smoke test, and a short changelog entry.
