// SPDX-License-Identifier: Apache-2.0
// Node names (C-113, C-114): the CN of every node certificate, the `node_id` of counter records and the
// `X-Scf-Edge-Node` header. One pattern everywhere.

export const NODE_NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
