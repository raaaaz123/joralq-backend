-- Core schema. Portable: runs on Supabase Postgres and on any plain Postgres 14+
-- (the test suite loads this file into a local database).

create extension if not exists pgcrypto;

do $$ begin
  create type user_role as enum ('teacher', 'student');
exception when duplicate_object then null; end $$;

-- One row per auth user. On Supabase, id = auth.users.id (FK added in 002).
create table if not exists profiles (
  id            uuid primary key,
  email         text not null,
  display_name  text not null check (char_length(display_name) between 1 and 80),
  role          user_role not null,
  created_at    timestamptz not null default now()
);
create index if not exists profiles_role_idx on profiles (role, display_name);

create table if not exists quizzes (
  id           uuid primary key default gen_random_uuid(),
  teacher_id   uuid not null references profiles (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 200),
  description  text not null default '',
  created_at   timestamptz not null default now()
);
create index if not exists quizzes_teacher_idx on quizzes (teacher_id, created_at desc);

create table if not exists questions (
  id        uuid primary key default gen_random_uuid(),
  quiz_id   uuid not null references quizzes (id) on delete cascade,
  position  int  not null check (position >= 0),
  prompt    text not null check (char_length(prompt) between 1 and 1000),
  unique (quiz_id, position)
);

create table if not exists question_options (
  id           uuid primary key default gen_random_uuid(),
  question_id  uuid not null references questions (id) on delete cascade,
  position     smallint not null check (position between 0 and 3),
  label        text not null check (char_length(label) between 1 and 500),
  is_correct   boolean not null default false,
  unique (question_id, position)
);
-- Exactly one correct option per question is enforced by the API on insert;
-- this index guarantees there can never be two.
create unique index if not exists question_options_one_correct
  on question_options (question_id) where is_correct;

create table if not exists assignments (
  id           uuid primary key default gen_random_uuid(),
  quiz_id      uuid not null references quizzes (id) on delete cascade,
  student_id   uuid not null references profiles (id) on delete cascade,
  assigned_at  timestamptz not null default now(),
  unique (quiz_id, student_id)
);
create index if not exists assignments_student_idx on assignments (student_id, assigned_at desc);

-- One attempt per assignment: the unique constraint is the last line of
-- defence against duplicate submissions (the API also checks under a row lock).
-- Score columns are a snapshot computed server-side at submit time, so
-- analytics and leaderboards never re-grade.
create table if not exists attempts (
  id               uuid primary key default gen_random_uuid(),
  assignment_id    uuid not null unique references assignments (id) on delete cascade,
  total_questions  int not null check (total_questions > 0),
  correct_count    int not null check (correct_count between 0 and total_questions),
  accuracy         numeric(5,2) not null check (accuracy between 0 and 100),
  submitted_at     timestamptz not null default now()
);

create table if not exists attempt_answers (
  attempt_id          uuid not null references attempts (id) on delete cascade,
  question_id         uuid not null references questions (id) on delete cascade,
  selected_option_id  uuid not null references question_options (id) on delete cascade,
  is_correct          boolean not null,
  primary key (attempt_id, question_id)
);
