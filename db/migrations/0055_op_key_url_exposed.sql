-- Source: docs/data-model.md, block '-- migration: 0055_op_key_url_exposed' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0055_op_key_url_exposed
-- C-119: an operator API key seen in a URL is compromised (wire-formats §k) and is revoked at once by the operator
-- metrics API (scf_metrics_ro), which has no write access to revocation columns. The caller passes the key id and
-- HMAC(pepper_op[pepper_version of that row], secret) it computed from the URL; only the stored hash revokes
-- (proof of possession: a made-up key with a real id revokes nothing). Returns 'revoked' (audited
-- api_key.compromised_url, platform chain, outcome success), 'already_revoked' (no change, no audit row) or
-- 'no_match' (unknown id or other secret; no audit row — the control plane may record the rejection itself).
INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('api_key.compromised_url', 'operator API key revoked because it was presented in a URL (wire-formats §k)',
  '{scf_op_definer}');

GRANT SELECT, UPDATE (revoked_at, revoke_reason, flagged_for_review_at) ON scf.operator_api_keys TO scf_op_definer;
CREATE POLICY op_definer_read ON scf.operator_api_keys FOR SELECT TO scf_op_definer USING (true);
-- revocation only: an unrevoked row may become revoked, nothing else
CREATE POLICY op_definer_revoke ON scf.operator_api_keys FOR UPDATE TO scf_op_definer
  USING (revoked_at IS NULL) WITH CHECK (revoked_at IS NOT NULL);

CREATE FUNCTION scf.op_key_url_exposed(p_key_id text, p_secret_hash bytea) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    -- one statement: concurrent calls serialise on the row, the second one finds it revoked
    UPDATE scf.operator_api_keys k
       SET revoked_at = now(), revoke_reason = 'compromised: presented in a URL',
           flagged_for_review_at = COALESCE(k.flagged_for_review_at, now())
     WHERE k.key_id = p_key_id AND k.secret_hash = p_secret_hash AND k.revoked_at IS NULL;
    IF NOT FOUND THEN
      RETURN CASE WHEN EXISTS (SELECT 1 FROM scf.operator_api_keys k
                                WHERE k.key_id = p_key_id AND k.secret_hash = p_secret_hash)
                  THEN 'already_revoked' ELSE 'no_match' END;
    END IF;
    INSERT INTO scf.audit_log (tenant_id, actor_kind, actor_id, action, target_type, target_id, outcome, details, request_id)
    VALUES (NULL, scf.actor_kind(), NULLIF(current_setting('app.actor_id', true), ''), 'api_key.compromised_url',
            'operator_api_key', p_key_id, 'success', jsonb_build_object('key_id', p_key_id),
            NULLIF(current_setting('app.request_id', true), ''));
    RETURN 'revoked';
  END $$;

-- C-114: grant, then owner.
REVOKE ALL ON FUNCTION scf.op_key_url_exposed(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.op_key_url_exposed(text, bytea) TO scf_metrics_ro;
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.op_key_url_exposed(text, bytea) OWNER TO scf_op_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;
