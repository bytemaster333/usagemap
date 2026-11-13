-- Source: docs/data-model.md, block '-- migration: 0015_services' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0015_services
CREATE TABLE scf.api_services (
  tenant_id             uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  service_id            uuid NOT NULL DEFAULT uuidv7(),
  service_name          text NOT NULL CHECK (service_name ~ '^[!-~]{1,128}$'),    -- printable ASCII
  display_name          text CHECK (char_length(display_name) <= 100),
  declared_base_url     text CHECK (char_length(declared_base_url) <= 2048
                                    AND declared_base_url ~ '^https://[^/?#[:space:]]+(/[^?#[:space:]]*)?$'),
  read_only_api         boolean NOT NULL DEFAULT false,     -- A3 "not applicable" (C-44)
  rpc_method_dimension  boolean NOT NULL DEFAULT false,     -- closed-set rpc.method dimension (ADR-0012)
  registration          text NOT NULL DEFAULT 'portal' CHECK (registration IN ('portal', 'auto')),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  registered_at         timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,
  created_by            uuid REFERENCES scf.users,          -- NULL for auto-registered
  PRIMARY KEY (tenant_id, service_id),
  UNIQUE (tenant_id, service_name),
  CHECK ((registration = 'auto') = (created_by IS NULL))
);

-- C-19: 'verified' only when the ledger shows a verified account of the tenant (stellar_account evidence) as the
-- contract's deployer or current admin; otherwise 'declared'.
CREATE TABLE scf.declared_contracts (
  tenant_id     uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  contract_ref  uuid NOT NULL DEFAULT uuidv7(),
  contract_id   text NOT NULL CHECK (contract_id ~ '^C[A-Z2-7]{55}$'),
  network       text NOT NULL CHECK (network IN ('public', 'testnet')),
  label         text CHECK (char_length(label) <= 100),
  service_id    uuid,                                -- optional: the API service it belongs to (A3)
  status        text NOT NULL DEFAULT 'declared' CHECK (status IN ('declared', 'verified')),
  verified_role text CHECK (verified_role IN ('deployer', 'admin')),
  verified_by_evidence uuid,                         -- the stellar_account evidence used
  verified_at   timestamptz,
  last_checked_at timestamptz,
  created_by    uuid NOT NULL REFERENCES scf.users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  PRIMARY KEY (tenant_id, contract_ref),
  UNIQUE (tenant_id, contract_id, network),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE SET NULL (service_id),
  FOREIGN KEY (tenant_id, verified_by_evidence) REFERENCES scf.verification_evidence (tenant_id, evidence_id),
  CHECK ((status = 'verified') = (verified_role IS NOT NULL AND verified_by_evidence IS NOT NULL))
);

CALL scf_admin.apply_tenant_rls('scf.api_services', '{SELECT,INSERT,UPDATE}', '{SELECT,INSERT}', '{SELECT}',
  '{"SELECT":["edge_snapshot","trust_scoring","public_metrics","erasure","tenant_purge","stream_gc"],"DELETE":["tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.declared_contracts', '{SELECT,INSERT,UPDATE}', '{}', '{SELECT}',
  '{"SELECT":["contract_verification","onchain_correlation","registry_sync","trust_scoring","tenant_purge"],
    "UPDATE":["contract_verification"],"DELETE":["tenant_purge"]}');
