-- Source: docs/data-model.md, block '-- migration: 0021_onchain' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0021_onchain
CREATE TABLE scf.onchain_daily (
  tenant_id               uuid   NOT NULL,
  contract_ref            uuid   NOT NULL,
  day                     date   NOT NULL,
  invocations             bigint NOT NULL CHECK (invocations >= 0),
  successful_invocations  bigint NOT NULL CHECK (successful_invocations >= 0),
  distinct_invokers       bigint NOT NULL CHECK (distinct_invokers >= 0),
  data_source             text   NOT NULL CHECK (data_source IN ('hubble', 'ledger_files')),
  computed_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contract_ref, day),
  FOREIGN KEY (tenant_id, contract_ref) REFERENCES scf.declared_contracts (tenant_id, contract_ref) ON DELETE CASCADE
);
CALL scf_admin.apply_tenant_rls('scf.onchain_daily', '{SELECT}', '{}', '{SELECT}',
  '{"SELECT":["onchain_correlation","trust_scoring","tenant_purge"],"INSERT":["onchain_correlation"],"UPDATE":["onchain_correlation"],"DELETE":["tenant_purge"]}');
