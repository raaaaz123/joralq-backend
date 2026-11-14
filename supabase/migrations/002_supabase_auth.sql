-- Supabase-only: ties profiles to auth.users and locks the tables away from
-- the public PostgREST API. Run after 001_schema.sql in the Supabase SQL editor.

alter table profiles
  drop constraint if exists profiles_id_fkey,
  add constraint profiles_id_fkey foreign key (id) references auth.users (id) on delete cascade;

-- Create the profile when someone signs up. The role is read from sign-up
-- metadata ONCE; afterwards the profiles row is the only source of truth, so a
-- user editing their own auth metadata later cannot change their role.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)),
    case when new.raw_user_meta_data ->> 'role' = 'teacher' then 'teacher'::user_role else 'student'::user_role end
  )
  on conflict (id) do nothing;
  return new;
end $$;

-- Trigger-only function: nobody should call it through /rest/v1/rpc.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- All data access goes through NestJS (direct Postgres connection). Enabling
-- RLS with no policies means the anon/authenticated keys in the browser cannot
-- read or write these tables through PostgREST at all.
alter table profiles         enable row level security;
alter table quizzes          enable row level security;
alter table questions        enable row level security;
alter table question_options enable row level security;
alter table assignments      enable row level security;
alter table attempts         enable row level security;
alter table attempt_answers  enable row level security;
