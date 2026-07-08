alter table public.proof_tasks
  add column parallel int not null default 1 check (parallel between 1 and 20);