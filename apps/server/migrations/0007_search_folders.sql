-- The folder (slug) of each search document, so a folder filter applies before candidate
-- selection. Ships with 0006, when every skill is still in "general".
alter table search.documents add column folder text;
update search.documents set folder = 'general';
alter table search.documents alter column folder set not null;

create index documents_folder_idx on search.documents (folder);
