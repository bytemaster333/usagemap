-- Source: docs/data-model.md, block '-- migration: 0031_partitions' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0031_partitions
CREATE FUNCTION scf_admin.partition_specs()
  RETURNS TABLE (tbl text, unit text, ahead int, keep interval) LANGUAGE sql IMMUTABLE
  AS $$ VALUES ('api_metrics_1m', 'day',   7, interval '35 days'),
               ('api_metrics_1h', 'month', 2, interval '25 months'),
               ('api_metrics_1d', 'year',  1, NULL::interval),
               ('web_hourly_totals', 'month', 2, interval '25 months') $$;   -- C-109

CREATE FUNCTION scf_admin.secure_partition(p_part regclass, p_parent regclass) RETURNS void LANGUAGE plpgsql
  AS $$
  DECLARE pol record;
  BEGIN
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_part);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_part);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_definer, scf_op_definer', p_part);
    FOR pol IN
      SELECT p.policyname, p.permissive, p.roles, p.cmd, p.qual, p.with_check
        FROM pg_catalog.pg_policies p
        JOIN pg_catalog.pg_class c ON c.relname = p.tablename
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = p.schemaname
       WHERE c.oid = p_parent
    LOOP
      EXECUTE format('CREATE POLICY %I ON %s AS %s FOR %s TO %s%s%s', pol.policyname, p_part, pol.permissive, pol.cmd,
        (SELECT string_agg(quote_ident(r), ', ') FROM unnest(pol.roles) AS r),
        CASE WHEN pol.qual IS NOT NULL THEN ' USING (' || pol.qual || ')' ELSE '' END,
        CASE WHEN pol.with_check IS NOT NULL THEN ' WITH CHECK (' || pol.with_check || ')' ELSE '' END);
    END LOOP;
  END $$;

CREATE FUNCTION scf.ensure_partitions() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE s record; i int; v_from timestamp; v_to timestamp; v_name text; v_made int := 0; v_fmt text;
  BEGIN
    FOR s IN SELECT * FROM scf_admin.partition_specs() LOOP
      v_fmt := CASE s.unit WHEN 'day' THEN 'YYYYMMDD' WHEN 'month' THEN 'YYYYMM' ELSE 'YYYY' END;
      FOR i IN 0 .. s.ahead LOOP
        v_from := date_trunc(s.unit, now() AT TIME ZONE 'UTC') + (i || ' ' || s.unit)::interval;
        v_to   := v_from + ('1 ' || s.unit)::interval;
        v_name := s.tbl || '_' || to_char(v_from, v_fmt);
        IF to_regclass(format('scf_part.%I', v_name)) IS NULL THEN
          EXECUTE format('CREATE TABLE scf_part.%I PARTITION OF scf.%I FOR VALUES FROM (%L) TO (%L) WITH (fillfactor = 80)',
                         v_name, s.tbl, to_char(v_from, 'YYYY-MM-DD HH24:MI:SS') || '+00', to_char(v_to, 'YYYY-MM-DD HH24:MI:SS') || '+00');
          PERFORM scf_admin.secure_partition(format('scf_part.%I', v_name)::regclass, format('scf.%I', s.tbl)::regclass);
          v_made := v_made + 1;
        END IF;
      END LOOP;
    END LOOP;
    RETURN v_made;
  END $$;

CREATE FUNCTION scf.drop_expired_partitions() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE s record; p record; v_upper timestamp; v_drops int := 0;
  BEGIN
    FOR s IN SELECT * FROM scf_admin.partition_specs() WHERE keep IS NOT NULL LOOP
      FOR p IN SELECT c.relname, substring(c.relname FROM length(s.tbl) + 2) AS suffix
                 FROM pg_catalog.pg_inherits h JOIN pg_catalog.pg_class c ON c.oid = h.inhrelid
                WHERE h.inhparent = format('scf.%I', s.tbl)::regclass
      LOOP
        v_upper := CASE s.unit WHEN 'day'   THEN to_date(p.suffix, 'YYYYMMDD') + interval '1 day'
                               WHEN 'month' THEN to_date(p.suffix || '01', 'YYYYMMDD') + interval '1 month'
                               ELSE              to_date(p.suffix || '0101', 'YYYYMMDD') + interval '1 year' END;
        IF v_upper <= (now() AT TIME ZONE 'UTC') - s.keep THEN
          EXECUTE format('ALTER TABLE scf.%I DETACH PARTITION scf_part.%I', s.tbl, p.relname);
          EXECUTE format('DROP TABLE scf_part.%I', p.relname);
          v_drops := v_drops + 1;
        END IF;
      END LOOP;
    END LOOP;
    RETURN v_drops;
  END $$;

ALTER FUNCTION scf.ensure_partitions() OWNER TO scf_migrator;
ALTER FUNCTION scf.drop_expired_partitions() OWNER TO scf_migrator;
REVOKE ALL ON FUNCTION scf.ensure_partitions(), scf.drop_expired_partitions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.ensure_partitions(), scf.drop_expired_partitions() TO scf_jobs;
SELECT scf.ensure_partitions();
