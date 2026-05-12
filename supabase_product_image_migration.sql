-- Adds a product thumbnail URL to each competitor.
-- Existing rows keep an empty value; edit or re-save a competitor URL to refresh it.

ALTER TABLE competitors
    ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT '';
