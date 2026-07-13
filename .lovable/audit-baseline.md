# Audit Baseline — 2026-07-13

## Code size (top files)
- actions.tsx: 3751
- actions-stream.ts: 1369
- tasks.functions.ts: 1266
- bot-flow.tsx: 1213
- tg-viewer.functions.ts: 938
- accounts.$id.tsx: 890
- dashboard.tsx: 769
- miniapp-proxy.$.ts: 761

Total src LOC: 37,330. Server modules: 44.

## DB hotspots
1. join_task_items WHERE task_id = ANY(...) — 5411 calls, 7.8s total
2. INSERT task_logs — 7202 calls, 3.8s total
3. INSERT action_logs — 2562 calls, 3.3s total
4. task_logs WHERE task_id + ORDER BY created_at DESC — 604 calls, 2.8s total
5. join_tasks ORDER BY created_at DESC — 2447 calls, 2.7s total

## Linter
- WARN: extension in public
- WARN x2: SECURITY DEFINER fns (has_role, is_admin — intentional, safe)

## Highest-ROI next actions
- Indexes on join_task_items(task_id), task_logs(task_id, created_at desc),
  action_logs(run_id, created_at desc), join_tasks(created_at desc)
- Batch client-side log inserts (reduce 10k single-row INSERTs)
- Split actions.tsx (3.7k lines) into feature tabs
