# Workload Reducer Pack

Ship 6 features that cut clicks and prevent lost work across every bulk flow.

## 1. One-click "Repeat last run"
- Add "Run again" button on every row of Recent Tasks, Scheduled Broadcasts, Bulk Mix history, and Bot Flow history.
- Clones the source payload (accounts, targets, delays, media, message HTML) into a new task queued immediately, no form re-open.
- If any account is now missing/banned, prompt once with a diff and let user proceed / drop / substitute.

## 2. Saved presets per action
- New `action_presets` table: `(id, user_id, kind, name, payload jsonb, created_at)`.
- "Save as preset" button on Join, Broadcast, Bulk Mix, Reactions, Cleanup, DM Blast forms captures the current form state.
- Preset dropdown at the top of each form loads a saved payload in one click. Rename/delete inline.

## 3. Global Favorites bar
- Pin up to 8 items (preset / recipe / bot flow / scheduled template) to a bar under the sidebar header.
- New `user_favorites` table `(id, user_id, kind, ref_id, label, sort_order)` with dnd-kit reordering.
- Clicking a favorite deep-links straight to the launcher with the preset pre-loaded and focuses the "Run" button.

## 4. Bulk target paste with auto-detect
- New `parseMixedTargets(text)` util classifies each line as: username, invite link, post link, numeric id, phone, junk.
- Paste box in every targets picker shows a live classified table (icon per type + count badges).
- Auto-routes classified items to correct fields (e.g., post links go to Bulk Mix post inputs, invites to join list). One-click "Fix junk" opens rejected lines for editing.

## 5. Smart account picker memory
- Persist last account selection per `(user_id, action_kind)` in `account_pick_memory` table `(user_id, kind, account_ids jsonb, updated_at)`.
- Account pickers pre-check the remembered set; show a small "Restored 12 accounts from last run" hint with an "Ignore" link.
- Auto-drops accounts that are now inactive/banned so restored sets stay clean.

## 7. Auto-resume interrupted runs
- Add `progress_cursor int` and `status_checkpoint jsonb` columns to `join_tasks` and `scheduled_broadcasts`.
- Task executor writes the cursor after every completed (account, target) pair.
- On worker start (and via a `/api/public/hooks/resume-stuck` cron every 5 min), pick up tasks in `running` status with no heartbeat for >2 min and continue from `progress_cursor` — no duplicate work.
- UI badge on Recent Tasks: "Auto-resumed at 47/120".

## Technical notes
- New tables all follow the `has_role` + user-scoped RLS pattern already used by `join_tasks`; add `GRANT` for `authenticated`/`service_role`.
- `action_presets` and `user_favorites` are shared across every launcher via a small `<PresetBar kind="broadcast" />` component.
- Auto-resume needs a `heartbeat_at timestamptz` column on `join_tasks` and `scheduled_broadcasts`, updated inside the runner loops.
- Repeat-run reuses existing `createTask` / `scheduleBroadcast` server functions; only a `clonePayload(sourceId)` helper is added.
- Paste parser is pure client-side, lives in `src/lib/target-parser.ts` with tests.
