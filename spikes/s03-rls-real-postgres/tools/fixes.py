"""Minimal fixes to docs/data-model.md migration blocks, as (old, new) exact-text replacements per migration.
Each entry is the patch proposed for docs/data-model.md (see README "Consequences"). Applied only in mode 'fixed'."""
FIXES = {
    # F1 (S-03 M13): the backstop's USING admits cross_tenant_read_ok(), and DELETE has no WITH CHECK, so a named job
    # running with app.tenant_id unset (web_rollup, trust_scoring, retention, stream_gc, ...) can DELETE any tenant's
    # rows. §6.3 says writes are always under the target tenant's context. Add a restrictive DELETE backstop.
    '0004_rls_helpers': [(
        """                   'WITH CHECK (%s AND (SELECT scf.tenant_ctx_ok()))', t, tp, tp);
""",
        """                   'WITH CHECK (%s AND (SELECT scf.tenant_ctx_ok()))', t, tp, tp);
    EXECUTE format('CREATE POLICY tenant_backstop_delete ON %s AS RESTRICTIVE FOR DELETE '
                   'TO scf_app, scf_writer, scf_jobs, scf_metrics_ro '
                   'USING (%s AND (SELECT scf.tenant_ctx_ok()))', t, tp);
"""),
    ],
}
