-- Source: docs/data-model.md, block '-- migration: 0013_sites' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0013_sites
CREATE TABLE scf.sites (
  tenant_id                 uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  site_id                   uuid NOT NULL DEFAULT uuidv7(),
  name                      text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  site_key                  text NOT NULL UNIQUE CHECK (site_key ~ '^[0-9A-Za-z]{22}$'),
  umami_website_id          uuid NOT NULL UNIQUE,                    -- never exposed; identified events
  umami_twin_website_id     uuid UNIQUE,                             -- never exposed; unidentified events (C-73)
  twin_provisioned_at       timestamptz,                             -- set by umami_reconcile once Umami has it
  tracker_profile           scf.tracker_profile NOT NULL DEFAULT 'standard',
  visitor_id                text NOT NULL CHECK (visitor_id IN ('on', 'off', 'off_in')),
  visitor_id_off_countries  char(2)[] NOT NULL DEFAULT '{}',
  visitor_id_explicit       boolean NOT NULL DEFAULT false,          -- tenant chose it (not the profile default)
  exclude_countries         char(2)[] NOT NULL DEFAULT '{}',
  anonymous_reports         boolean NOT NULL DEFAULT true,
  path_folding              text NOT NULL DEFAULT 'full' CHECK (path_folding IN ('full', 'relaxed')),
  event_retention_days      smallint CHECK (event_retention_days BETWEEN 30 AND 395),   -- NULL = platform setting
  opt_out_page_url          text CHECK (char_length(opt_out_page_url) <= 2048 AND opt_out_page_url ~ '^https://[^[:space:]]+$'),
  status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'purging')),
  created_by                uuid NOT NULL REFERENCES scf.users,
  created_at                timestamptz NOT NULL DEFAULT now(),
  archived_at               timestamptz,
  PRIMARY KEY (tenant_id, site_id),
  UNIQUE (site_id),
  CHECK (umami_twin_website_id IS DISTINCT FROM umami_website_id),
  CHECK (twin_provisioned_at IS NULL OR umami_twin_website_id IS NOT NULL),
  CHECK (visitor_id = 'on' OR umami_twin_website_id IS NOT NULL),       -- assigned in the same transaction
  CHECK ((visitor_id = 'off_in') = (cardinality(visitor_id_off_countries) > 0)),
  CHECK (array_to_string(visitor_id_off_countries, ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'),
  CHECK (array_to_string(exclude_countries, ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$')
);
-- Effective retention = LEAST(site.event_retention_days, settings.web_event_retention_days) (C-18, C-54).

CREATE TABLE scf.site_domains (       -- hosts are lower-case A-labels, no port, no trailing dot
  tenant_id           uuid NOT NULL,
  domain_id           uuid NOT NULL DEFAULT uuidv7(),
  site_id             uuid NOT NULL,
  host                text NOT NULL CHECK (char_length(host) <= 253
                        AND host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  include_subdomains  boolean NOT NULL DEFAULT false,    -- honoured only with a dns_txt proof at this host
  state               text NOT NULL DEFAULT 'unverified' CHECK (state IN ('unverified', 'verified', 'lapsed', 'disputed')),
  verified_at         timestamptz,
  lapsed_at           timestamptz,
  grace_until         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, domain_id),
  UNIQUE (tenant_id, site_id, host),
  FOREIGN KEY (tenant_id, site_id) REFERENCES scf.sites (tenant_id, site_id) ON DELETE CASCADE
);
CREATE INDEX site_domains_site ON scf.site_domains (tenant_id, site_id);

-- dns_txt: TXT at _scf-verify.<host> = "scf-verify=<token>"; well_known: https://<host>/.well-known/scf-verify.txt
-- body = <token>; meta_tag: <meta name="scf-site-verification" content="<token>"> in the HTML served at https://<host>/
CREATE TABLE scf.domain_verifications (
  tenant_id            uuid NOT NULL,
  verification_id      uuid NOT NULL DEFAULT uuidv7(),
  domain_id            uuid NOT NULL,
  method               scf.domain_method NOT NULL,
  token                text NOT NULL CHECK (token ~ '^[0-9A-Za-z_-]{22}$'),      -- 128-bit base64url
  status               scf.domain_verification_status NOT NULL DEFAULT 'pending',
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,                                       -- +7 days while pending
  verified_at          timestamptz,
  last_checked_at      timestamptz,
  next_check_at        timestamptz,
  consecutive_failures smallint NOT NULL DEFAULT 0,
  last_result_code     text CHECK (last_result_code IN ('OK', 'DNS_NXDOMAIN', 'DNS_NO_TXT', 'DNS_SERVFAIL',
                         'TOKEN_MISMATCH', 'HTTP_STATUS', 'HTTP_REDIRECT_REFUSED', 'PRIVATE_ADDRESS_REFUSED',
                         'TIMEOUT', 'TOO_LARGE', 'TLS_ERROR', 'META_NOT_FOUND', 'HOST_CLAIMED_ELSEWHERE', 'HOST_TOMBSTONED')),
  PRIMARY KEY (tenant_id, verification_id),
  FOREIGN KEY (tenant_id, domain_id) REFERENCES scf.site_domains (tenant_id, domain_id) ON DELETE CASCADE
);
CREATE INDEX domain_verifications_due ON scf.domain_verifications (next_check_at) WHERE status IN ('pending', 'verified');

-- Global uniqueness of verified hosts, written only by scf.claim_host()/scf.release_host() (§12).
-- Primary key host (not tenant_id first): the table exists to make a host unique across tenants (§15 G9 allow-list).
CREATE TABLE scf.host_claims (
  host        text PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  domain_id   uuid NOT NULL,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, domain_id) REFERENCES scf.site_domains (tenant_id, domain_id) ON DELETE CASCADE
);
CREATE INDEX host_claims_tenant ON scf.host_claims (tenant_id);

CALL scf_admin.apply_tenant_rls('scf.sites', '{SELECT,INSERT,UPDATE}', '{}', '{SELECT,UPDATE}',
  '{"SELECT":["edge_snapshot","web_rollup","trust_scoring","erasure","tenant_purge","public_metrics","umami_reconcile","retention","durability_reconcile"],
    "UPDATE":["tenant_purge","umami_reconcile"],"DELETE":["tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.site_domains', '{SELECT,INSERT,UPDATE,DELETE}', '{}', '{SELECT,UPDATE}',
  '{"SELECT":["edge_snapshot","domain_verification","registry_sync","tenant_purge"],"UPDATE":["domain_verification"],"DELETE":["tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.domain_verifications', '{SELECT,INSERT,UPDATE}', '{}', '{SELECT}',
  '{"SELECT":["domain_verification","retention","tenant_purge"],"UPDATE":["domain_verification"],"DELETE":["retention","tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.host_claims', '{SELECT}', '{}', '{SELECT}',
  '{"SELECT":["edge_snapshot","tenant_purge"]}');
GRANT SELECT, INSERT, UPDATE, DELETE ON scf.host_claims TO scf_definer;
CREATE POLICY definer_claims ON scf.host_claims FOR ALL TO scf_definer USING (true) WITH CHECK (true);
