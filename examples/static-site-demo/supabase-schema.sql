create table coin_moebius_transactions (
  payment_id     text primary key,
  status         text not null check (status in ('pending', 'success', 'failed')),
  provider       text not null,
  amount         numeric not null,
  currency       text not null,
  metadata       jsonb not null default '{}',
  confirmations  integer default 0,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

alter table coin_moebius_transactions enable row level security;
create policy "webhook can write" on coin_moebius_transactions
  for all using (true) with check (true);

create index idx_payment_id on coin_moebius_transactions (payment_id);
