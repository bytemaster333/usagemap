// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 0062 (C-129, tracker.intentional-upgrade): web counter `tracker_version` (label v<major>_<minor>_<patch>) is accepted; any other counter
// name is still refused by the check, and the label pattern still forbids dots.
func TestTrackerVersionCounter0062(t *testing.T) {
	ctx := context.Background()
	tx, err := super(t).Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	insert := func(counter, label string) error {
		return savepoint(ctx, tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(ctx, fmt.Sprintf(`INSERT INTO scf.web_edge_counters VALUES ('%s', '%s',
			  (now() AT TIME ZONE 'UTC')::date, $1, $2, 7)`, A, uid(A, 1)), counter, label)
			return err
		})
	}
	for _, label := range []string{"v1_0_0", "v1_2_10"} {
		if err := insert("tracker_version", label); err != nil {
			t.Errorf("tracker_version/%s refused: %s", label, sqlState(err))
		}
	}
	if err := insert("tracker_versions", "v1_0_0"); code(err) != "23514" {
		t.Errorf("unknown counter: want 23514, got %s", sqlState(err))
	}
	if err := insert("tracker_version", "v1.0.0"); code(err) != "23514" {
		t.Errorf("label with dots: want 23514, got %s", sqlState(err))
	}
}
