// SPDX-License-Identifier: Apache-2.0
// Above every project page: the secret-seed leak warning when there is one. The project's sections are in the app
// shell's sidebar (components/shell/nav.tsx).

import { SecretSeedBanner } from "../components/SecretSeedBanner.tsx";

export function TenantNav({ tenantId }: { tenantId: string }) {
  return <SecretSeedBanner tenantId={tenantId} />;
}
