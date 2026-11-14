// SPDX-License-Identifier: Apache-2.0
// Package dbtests is the database gate suite (docs/data-model.md §15, C-103, C-112(12)): it migrates a fresh
// PostgreSQL 18.6 with the db-migrate image (db/Dockerfile), then checks the gates G1–G10 with one deliberate
// breakage each, the cross-tenant matrix enumerated from the catalog (direct and through PgBouncer in transaction
// mode), every op_* function, the audit chain, the histogram SQL (S-05), partitions, the live window, the retention
// helpers, the umami scf_ro step and the migration runner itself.
//
// The tests start their own Compose stack (project scf-wse, host ports 56100–56101, see compose.yaml) and remove it
// at the end; KEEP=1 leaves it running. Without Docker the suite is skipped, unless CI is set (then it fails).
//
// The package also holds the source lint of C-103 (ScanContextBypass): application code never calls set_config( and
// never issues SET/RESET app.* — tenant context is set only through scf.set_tenant_ctx().
package dbtests
