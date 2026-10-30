-- 0006 seeded the default folder with a Russian name and description ("Общие" = "General").
-- Rename it to English, but only where nobody has edited it since: a name or description an
-- admin changed is left as is. Search stores the folder slug, not its name, so no reindex.
update catalog.folders
set name = 'General',
    description = 'General skills without a specific topic',
    updated_at = now()
where slug = 'general'
  and name = 'Общие'
  and description = 'Общие skills без отдельной темы';
