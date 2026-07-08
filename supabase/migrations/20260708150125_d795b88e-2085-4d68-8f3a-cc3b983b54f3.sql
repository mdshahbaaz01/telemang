create table public.proof_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel_link text not null,
  target text not null,
  caption text,
  format text not null default 'auto' check (format in ('auto','chat_list','channel_view')),
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.proof_tasks to authenticated;
grant all on public.proof_tasks to service_role;
alter table public.proof_tasks enable row level security;
create policy "proof_tasks_own" on public.proof_tasks
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table public.proof_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.proof_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.telegram_accounts(id) on delete cascade,
  status text not null default 'pending',
  channel_title text,
  channel_username text,
  subscribers int,
  format_used text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.proof_runs to authenticated;
grant all on public.proof_runs to service_role;
alter table public.proof_runs enable row level security;
create policy "proof_runs_own" on public.proof_runs
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index idx_proof_runs_task on public.proof_runs(task_id);
create index idx_proof_tasks_user on public.proof_tasks(user_id, created_at desc);