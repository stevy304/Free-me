-- Full-text search without reading every video: the same expression the search query matches on, indexed.
CREATE INDEX "Video_search_fts_idx" ON "Video" USING GIN (to_tsvector('simple'::regconfig, "title" || ' ' || coalesce("description", '')));
