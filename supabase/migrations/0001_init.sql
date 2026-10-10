-- Aangan Studio enquiry store. Server-side access only (service role); RLS on, no policies.

create table if not exists enquiries (
  id text primary key,                 -- our id (uuid for live calls, T01.. for fixtures)
  external_id text unique,             -- voice provider call id
  channel text not null check (channel in ('phone','whatsapp','web_form')),
  caller_name text,
  caller_number text,
  received_at timestamptz not null,
  first_response_at timestamptz,       -- first agent reply (or callback completed for missed calls)
  ended_at timestamptz,
  contact_status text not null check (contact_status in ('answered','missed','dropped')),
  state text not null default 'in_progress' check (state in ('in_progress','completed')),
  outcome text check (outcome in ('QUALIFIED','DECLINED','ESCALATED','CALLBACK')),
  decline_reason text,
  recovery boolean not null default false,
  after_hours boolean not null default false,
  language text,
  facts jsonb,
  session jsonb,                       -- serialised core SessionState between webhook turns
  created_at timestamptz not null default now()
);
create index if not exists enquiries_received_at on enquiries (received_at desc);
create index if not exists enquiries_caller_number on enquiries (caller_number);

create table if not exists turns (
  id bigint generated always as identity primary key,
  enquiry_id text not null references enquiries(id) on delete cascade,
  idx int not null,
  speaker text not null check (speaker in ('caller','agent')),
  text text not null,
  action text,
  guardrail_triggered boolean not null default false,
  at timestamptz,
  unique (enquiry_id, idx)
);

create table if not exists qualifications (
  enquiry_id text primary key references enquiries(id) on delete cascade,
  verdict text not null check (verdict in ('QUALIFIED','UNCERTAIN','NOT_QUALIFIED')),
  criteria jsonb not null,
  failed int[] not null default '{}',
  uncertain int[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists handoffs (
  id bigint generated always as identity primary key,
  enquiry_id text not null references enquiries(id) on delete cascade,
  kind text not null check (kind in ('designer','escalation','callback_alert')),
  channel text not null check (channel in ('telegram','email')),
  status text not null check (status in ('sent','failed','stubbed')),
  note jsonb,
  body text not null,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists bookings (
  id bigint generated always as identity primary key,
  enquiry_id text not null references enquiries(id) on delete cascade,
  url text not null,
  status text not null default 'link_sent' check (status in ('link_sent','booked','cancelled')),
  slot_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists callbacks (
  id bigint generated always as identity primary key,
  enquiry_id text references enquiries(id) on delete cascade,
  caller_number text,
  kind text not null check (kind in ('callback','followup')),
  reason text not null,
  due_by timestamptz not null,
  status text not null default 'pending' check (status in ('pending','done','resolved_by_caller')),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists callbacks_pending on callbacks (status, due_by);

create table if not exists cost (
  id bigint generated always as identity primary key,
  enquiry_id text not null references enquiries(id) on delete cascade,
  provider text not null,
  model text not null,
  purpose text not null,
  input_tokens int not null,
  output_tokens int not null,
  cost_inr numeric(12,5) not null,
  created_at timestamptz not null default now()
);

alter table enquiries enable row level security;
alter table turns enable row level security;
alter table qualifications enable row level security;
alter table handoffs enable row level security;
alter table bookings enable row level security;
alter table callbacks enable row level security;
alter table cost enable row level security;
