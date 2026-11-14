// SPDX-License-Identifier: Apache-2.0
// Package collectortests holds the tests of the scf-otelcol distribution as a
// whole: the configuration lint (always runs), and — against the built binary
// (collector/scripts/build.sh) and the Docker image (collector/Dockerfile) —
// the component golden file, the end-to-end behaviour (canary trace, logs
// refused, tenant overwrite, queue durability across kill -9) and the
// two-writer failover over mutual TLS. See collector/README.md.
package collectortests
