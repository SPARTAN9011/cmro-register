-- ============================================================
--  CMRO Duty Register — database setup
--  Run this ONCE in Supabase:  SQL Editor -> New query -> paste -> Run
-- ============================================================

-- ---------- tables ----------
create table if not exists users (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  designation  text,
  username     text unique not null,
  pin          text not null,
  role         text not null default 'employee',   -- employee | supervisor | admin
  disabled     boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists attendance (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  date       date not null,
  clock_in   text,                 -- "HH:MM" or null
  leave      boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, date)           -- one row per person per day (needed for upsert)
);

create table if not exists day_status (
  date       date primary key,
  finalized  boolean not null default false,
  reopened   boolean not null default false
);

create table if not exists settings (
  id            int primary key default 1,
  section       text not null default 'CMRO Section',
  report_time   text not null default '10:30',
  late_after    text not null default '10:00',
  working_days  int[] not null default '{1,2,3,4,5}'   -- 0=Sun ... 6=Sat
);

-- ---------- access policies ----------
-- The app runs in the browser with the public "anon" key and validates a PIN
-- inside the app. These policies let the app read/write. This is a lightweight
-- model suited to an internal, trusted office. See SETUP-GUIDE.md -> Security
-- for how to lock it down further later.
alter table users      enable row level security;
alter table attendance enable row level security;
alter table day_status enable row level security;
alter table settings   enable row level security;

drop policy if exists app_all on users;
drop policy if exists app_all on attendance;
drop policy if exists app_all on day_status;
drop policy if exists app_all on settings;

create policy app_all on users      for all to anon using (true) with check (true);
create policy app_all on attendance for all to anon using (true) with check (true);
create policy app_all on day_status for all to anon using (true) with check (true);
create policy app_all on settings   for all to anon using (true) with check (true);

-- ---------- default settings ----------
insert into settings (id) values (1) on conflict (id) do nothing;

-- ---------- seed roster (from the CMRO attendance report) ----------
-- Everyone starts with PIN 1234. Change PINs from the People screen after login.
insert into users (name, designation, username, pin, role) values
  ('Md.Ashrafunnisa Begum','Supdt','ashrafunnisa','1234','admin'),
  ('Y.Jeevan Kumar','Tahsildar','jeevan','1234','supervisor'),
  ('S.Naga Jyothi','Tahsildar','naga','1234','employee'),
  ('T.Hari Babu','DT','hari','1234','employee'),
  ('Y.Nageswara Rao','DT','nageswara','1234','employee'),
  ('M.Tharun Kumar','SA','tharun','1234','employee'),
  ('B.Akhil','JA','akhil','1234','employee'),
  ('P.Vinay Kumar','JA','vinay','1234','employee'),
  ('V.Aswini','JA','aswini','1234','employee'),
  ('B.Harsha Vardhan','Sr.BA','harsha','1234','employee'),
  ('Sk.John Basha','Sr.BA','john','1234','employee'),
  ('Revathi Kosuri','Sr.PC','revathi','1234','employee'),
  ('M.Ajay Kumar','PC','ajay','1234','employee'),
  ('M.V.Siva Sudhakar','Sr.PE','sivasudhakar','1234','employee'),
  ('M.Bhavani','PE','bhavani','1234','employee'),
  ('R.Lavanya','PE','lavanya','1234','employee'),
  ('C.Ramesh','PE','ramesh','1234','employee'),
  ('K.Siva Shankar','PE','sivashankar','1234','employee'),
  ('G.Sarika','TM','sarika','1234','employee'),
  ('Y.Jagadish','DEO','jagadish','1234','employee')
on conflict (username) do nothing;
