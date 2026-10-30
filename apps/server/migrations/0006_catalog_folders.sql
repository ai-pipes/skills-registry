-- Skill folders: every skill lives in exactly one folder. Existing skills go to the default
-- folder "general". Its name and description were seeded in Russian ("Общие" = "General");
-- 0009 renames them to English. Shipped migrations are not edited.
create table catalog.folders (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  description text not null,
  status text not null check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into catalog.folders (id, slug, name, description, status)
values (
  '00000000-0000-4000-8000-000000000001',
  'general',
  'Общие',
  'Общие skills без отдельной темы',
  'active'
);

alter table catalog.skills add column folder_id uuid references catalog.folders(id);
update catalog.skills set folder_id = '00000000-0000-4000-8000-000000000001';
alter table catalog.skills alter column folder_id set not null;

create index skills_folder_idx on catalog.skills (folder_id);
