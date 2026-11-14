-- SPDX-License-Identifier: Apache-2.0
-- Step 1 of an Umami upgrade (docs/data-model.md §16.3): a view that selects a column blocks an Umami migration that
-- alters it, so the views go before umami-migrate runs and scf_ro.sql recreates them afterwards.
--   db/migrate.sh umami-views-drop   (superuser of the umami database)
\set ON_ERROR_STOP on
DROP SCHEMA IF EXISTS scf_ro CASCADE;
