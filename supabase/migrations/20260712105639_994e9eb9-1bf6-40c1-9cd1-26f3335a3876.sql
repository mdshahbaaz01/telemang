
create table if not exists public.captcha_solvers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('twocaptcha','anticaptcha','capsolver')),
  label text not null default '',
  api_key_encrypted text not null,
  enabled boolean not null default true,
  priority int not null default 100,
  settings jsonb not null default '{}'::jsonb,
  balance_cached numeric,
  balance_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, label)
);

grant select, insert, update, delete on public.captcha_solvers to authenticated;
grant all on public.captcha_solvers to service_role;

alter table public.captcha_solvers enable row level security;

create policy "users manage their solvers"
  on public.captcha_solvers for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create trigger set_updated_at_captcha_solvers
  before update on public.captcha_solvers
  for each row execute function public.set_updated_at();

create table if not exists public.captcha_solve_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  kind text not null,
  success boolean not null,
  latency_ms int,
  cost_usd numeric,
  answer_preview text,
  error text,
  context jsonb not null default '{}'::jsonb,
  account_id uuid references public.telegram_accounts(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists captcha_solve_log_user_idx on public.captcha_solve_log(user_id, created_at desc);

grant select, insert, delete on public.captcha_solve_log to authenticated;
grant all on public.captcha_solve_log to service_role;

alter table public.captcha_solve_log enable row level security;

create policy "users view their solve log"
  on public.captcha_solve_log for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users insert their solve log"
  on public.captcha_solve_log for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users delete their solve log"
  on public.captcha_solve_log for delete
  to authenticated
  using (auth.uid() = user_id);
