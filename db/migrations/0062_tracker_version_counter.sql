-- Source: docs/data-model.md, block '-- migration: 0062_tracker_version_counter' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0062_tracker_version_counter
-- C-129 (WEB-11): the gateway counts verified and suspect events per payload `tv` as web counter `tracker_version`,
-- label `v<major>_<minor>_<patch>` (the label pattern forbids dots); the installation check reports the version seen.
ALTER TABLE scf.web_edge_counters DROP CONSTRAINT web_edge_counters_counter_check;
ALTER TABLE scf.web_edge_counters ADD CONSTRAINT web_edge_counters_counter_check
  CHECK (counter IN ('verdict','reason','asn_class','client_signal','pow_latency','multiplicity','identifier',
                     'kit_present_pageviews','drop','tracker_version'));
