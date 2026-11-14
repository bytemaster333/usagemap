-- Source: docs/data-model.md, block '-- migration: 0051_edge_boot_id' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0051_edge_boot_id
ALTER TABLE scf.edge_spool_accounting
  ADD COLUMN last_boot_id uuid;                     -- spool.boot_id of the latest applied counter record (C-113)
