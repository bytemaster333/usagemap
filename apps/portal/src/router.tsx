// SPDX-License-Identifier: Apache-2.0
// Routes (TanStack Router, ADR-0024): typed paths, search parameters as view state.

import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
} from "@tanstack/react-router";
import { ReauthProvider } from "./auth/ReauthProvider.tsx";
import { AppShell } from "./components/AppShell.tsx";
import { ReadOnlyBanner } from "./components/ReadOnlyBanner.tsx";
import {
  OTEL_STACKS,
  type OtelStack,
  parseApiDashboardSearch,
  parseApiWizardSearch,
  parseAuditSearch,
  parseDashboardSearch,
  parseOperatorSearch,
  parseOperatorTenantsSearch,
  parseRangeShort,
  parseReturnToSearch,
  parseSignInSearch,
  parseSnippetSearch,
  parseWebWizardSearch,
} from "./lib/search.ts";
import { AccountPage } from "./pages/Account.tsx";
import { ApiDashboardPage } from "./pages/ApiDashboard.tsx";
import { ErasureDetailPage, ErasureListPage } from "./pages/Erasure.tsx";
// SCF Evidence Link
import { EvidencePage } from "./pages/evidence/EvidencePage.tsx";
import { FootprintWizardPage } from "./pages/Footprint.tsx";
import { IngestTokensPage } from "./pages/IngestTokens.tsx";
import { InstallationPage } from "./pages/Installation.tsx";
import { IntegrationsPage } from "./pages/integrations/Integrations.tsx";
import { parseIntegrationsSearch } from "./pages/integrations/model.ts";
import { NotFoundPage } from "./pages/NotFound.tsx";
import { ApiWizardPage, OnboardingPage, WebWizardPage } from "./pages/Onboarding.tsx";
import { OtelSetupPage } from "./pages/OtelSetup.tsx";
// MCP OAuth consent and connected apps
import { ConnectedAppsPage } from "./pages/oauth/ConnectedApps.tsx";
import { OAuthConsentPage } from "./pages/oauth/Consent.tsx";
import { parseConsentSearch } from "./pages/oauth/model.ts";
import { FindProjectPage } from "./pages/onboard/FindProject.tsx";
import { KitPage } from "./pages/onboard/Kit.tsx";
import { parseCoverageSearch, parseKitSearch, parseOnboardSearch } from "./pages/onboard/model.ts";
import { parseOpSearch } from "./pages/operator/model.ts";
import {
  OperatorApiKeysPage,
  OperatorAuditPage,
  OperatorErasurePage,
  OperatorSettingsPage,
  OperatorTombstonesPage,
} from "./pages/operator/OperatorAdmin.tsx";
import { OperatorApiPage } from "./pages/operator/OperatorApi.tsx";
import { OperatorCohortsPage, parseCohortSearch } from "./pages/operator/OperatorCohorts.tsx";
import { OperatorCoveragePage } from "./pages/operator/OperatorCoverage.tsx";
import { OperatorLayout } from "./pages/operator/OperatorLayout.tsx";
import { OperatorOperatorsPage } from "./pages/operator/OperatorOperators.tsx";
import { OperatorOverviewPage } from "./pages/operator/OperatorOverview.tsx";
import {
  OperatorProtocolsPage,
  parseOperatorProtocolsSearch,
} from "./pages/operator/OperatorProtocols.tsx";
import { OperatorTenantPage, OperatorTenantsPage } from "./pages/operator/OperatorTenants.tsx";
import { OperatorWebPage } from "./pages/operator/OperatorWeb.tsx";
import { parseUsageMapSearch } from "./pages/operator/usagemap/model.ts";
import { UsageMapPage } from "./pages/operator/usagemap/UsageMap.tsx";
import {
  parseUsageProjectSearch,
  UsageMapProjectPage,
} from "./pages/operator/usagemap/UsageMapProject.tsx";
import { PasskeyStepPage } from "./pages/PasskeyStep.tsx";
import { PublicStatsPage } from "./pages/PublicStats.tsx";
import { AppsPage, parseAppsSearch } from "./pages/project/Apps.tsx";
import { OnchainPage, parseOnchainSearch } from "./pages/project/Onchain.tsx";
import { OverviewPage, parseOverviewSearch } from "./pages/project/Overview.tsx";
import {
  BrowserCallsPage,
  parseBrowserSearch,
  WalletsIndexPage,
  WebIndexPage,
} from "./pages/project/Sections.tsx";
import { parseSettingsSearch, SettingsPage } from "./pages/project/Settings.tsx";
import { TenantProtocolsPage } from "./pages/protocols/TenantProtocols.tsx";
import { ServiceLayout } from "./pages/ServiceLayout.tsx";
import { ServicesPage } from "./pages/Services.tsx";
import { parseSharingSearch, SharingPage } from "./pages/Sharing.tsx";
import { SignInPage } from "./pages/SignIn.tsx";
import { SiteDashboardPage } from "./pages/SiteDashboard.tsx";
import { SiteLayout } from "./pages/SiteLayout.tsx";
import { SiteSettingsPage } from "./pages/SiteSettings.tsx";
import { SnippetPage } from "./pages/Snippet.tsx";
import { AcceptInvitationPage, TeamPage } from "./pages/Team.tsx";
import { TenantsPage } from "./pages/Tenants.tsx";
import { TractionSnapshotsPage } from "./pages/TractionSnapshots.tsx";
import { parseTrustSearch, TrustPage, VerificationPage } from "./pages/Trust.tsx";
import { parseTenantUsageSearch } from "./pages/usagemap/model.ts";
import { TenantUsageMapPage } from "./pages/usagemap/TenantUsageMap.tsx";
import { parseVerifySearch, VerifySnapshotPage } from "./pages/VerifySnapshot.tsx";
import { parseWalletSearch, WalletFunnelPage } from "./pages/WalletFunnel.tsx";
import { parseReportsSearch, WebReportsPage } from "./pages/WebReports.tsx";

function Root() {
  return (
    <ReauthProvider>
      <div className="um-root">
        <ReadOnlyBanner />
        <Outlet />
      </div>
    </ReauthProvider>
  );
}

const rootRoute = createRootRoute({ component: Root, notFoundComponent: NotFoundPage });

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signin",
  validateSearch: parseSignInSearch,
  component: SignInPage,
});

const passkeyStepRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signin/passkey",
  validateSearch: parseReturnToSearch,
  component: PasskeyStepPage,
});

// Public programme outputs (share.signed-usage-report, wire-formats §i): no session, outside the signed-in frame.
const publicStatsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$slug",
  component: PublicStatsPage,
});

const verifySnapshotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/verify/$snapshotId",
  component: VerifySnapshotPage,
});

// The `links.verify` form of a v2 snapshot (wire-formats §i.3.2): /verify?snapshot=<id>.
const verifyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/verify",
  validateSearch: parseVerifySearch,
  component: VerifySnapshotPage,
});

// SCF Evidence Link: the public evidence page of a signed traction snapshot.
const evidenceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/evidence/$snapshotId",
  component: EvidencePage,
});

const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: AppShell });

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: () => <Navigate to="/tenants" replace />,
});

const tenantsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tenants",
  component: TenantsPage,
});

// MCP OAuth: consent for an MCP client and the list of connected apps.
const oauthConsentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/oauth/consent",
  validateSearch: parseConsentSearch,
  component: OAuthConsentPage,
});

const oauthAppsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/oauth/apps",
  component: ConnectedAppsPage,
});

const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/account",
  component: AccountPage,
});

const tenantRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId",
  validateSearch: parseOverviewSearch,
  component: OverviewPage,
});

const siteRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/sites/$siteId",
  component: SiteLayout,
});

const siteDashboardRoute = createRoute({
  getParentRoute: () => siteRoute,
  path: "/",
  validateSearch: parseDashboardSearch,
  component: SiteDashboardPage,
});

const walletsRoute = createRoute({
  getParentRoute: () => siteRoute,
  path: "/wallets",
  validateSearch: parseWalletSearch,
  component: WalletFunnelPage,
});

const reportsRoute = createRoute({
  getParentRoute: () => siteRoute,
  path: "/reports",
  validateSearch: parseReportsSearch,
  component: WebReportsPage,
});

const installationRoute = createRoute({
  getParentRoute: () => siteRoute,
  path: "/installation",
  validateSearch: parseRangeShort,
  component: InstallationPage,
});

const snippetRoute = createRoute({
  getParentRoute: () => siteRoute,
  path: "/snippet",
  validateSearch: parseSnippetSearch,
  component: SnippetPage,
});

const browserRoute = createRoute({
  getParentRoute: () => siteRoute,
  path: "/browser",
  validateSearch: parseBrowserSearch,
  component: BrowserCallsPage,
});

// --- project sections (approved project dashboard design) ---
const webIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/web",
  component: WebIndexPage,
});

const walletsIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/wallets",
  component: WalletsIndexPage,
});

const appsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/apps",
  validateSearch: parseAppsSearch,
  component: AppsPage,
});

const onchainRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/onchain",
  validateSearch: parseOnchainSearch,
  component: OnchainPage,
});

const footprintRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/footprint",
  component: FootprintWizardPage,
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/settings",
  validateSearch: parseSettingsSearch,
  component: SettingsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => siteRoute,
  path: "/settings",
  component: SiteSettingsPage,
});

// --- API services, tokens, erasure, set-up wizard (dashboard.api-*, isolation.api-dashboard, privacy.tenant-erasure) ---

const servicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/services",
  component: ServicesPage,
});

const serviceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/services/$serviceId",
  component: ServiceLayout,
});

const apiDashboardRoute = createRoute({
  getParentRoute: () => serviceRoute,
  path: "/",
  validateSearch: parseApiDashboardSearch,
  component: ApiDashboardPage,
});

const parseStack = (s: Record<string, unknown>): { stack: OtelStack } => ({
  stack: (OTEL_STACKS as readonly unknown[]).includes(s.stack) ? (s.stack as OtelStack) : "node",
});

const otelSetupRoute = createRoute({
  getParentRoute: () => serviceRoute,
  path: "/setup",
  validateSearch: parseStack,
  component: OtelSetupPage,
});

const tokensRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/ingest-tokens",
  component: IngestTokensPage,
});

const snapshotsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/traction-snapshots",
  component: TractionSnapshotsPage,
});

const sharingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/sharing",
  validateSearch: parseSharingSearch,
  component: SharingPage,
});

const erasureRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/erasure",
  component: ErasureListPage,
});

const erasureDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/erasure/$requestId",
  component: ErasureDetailPage,
});

// --- team (members, invitations) and the verification ladder (tenancy.sites-and-services, ADR-0015, C-19) ---

const teamRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/team",
  component: TeamPage,
});

const trustRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/trust",
  validateSearch: parseTrustSearch,
  component: TrustPage,
});

const verificationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/verification",
  validateSearch: parseTrustSearch,
  component: VerificationPage,
});

const tenantUsageMapRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/usage-map",
  validateSearch: parseTenantUsageSearch,
  component: TenantUsageMapPage,
});

// --- Protocol interactions (migration 0082) ---
const tenantProtocolsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/protocols",
  validateSearch: parseTenantUsageSearch,
  component: TenantProtocolsPage,
});

const operatorProtocolsRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/protocols",
  validateSearch: parseOperatorProtocolsSearch,
  component: OperatorProtocolsPage,
});

const acceptInvitationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/invitations/accept",
  component: AcceptInvitationPage,
});

const setupRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/setup",
  component: OnboardingPage,
});

const setupWebRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/setup/web",
  validateSearch: parseWebWizardSearch,
  component: WebWizardPage,
});

const setupFootprintRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/setup/footprint",
  component: FootprintWizardPage,
});

const setupApiRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/setup/api",
  validateSearch: parseApiWizardSearch,
  component: ApiWizardPage,
});

// --- onboarding of Stellar ecosystem projects: registry picker, integration kit, operator coverage ---

const onboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/onboard",
  validateSearch: parseOnboardSearch,
  component: FindProjectPage,
});

const kitRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/onboard/kit",
  validateSearch: parseKitSearch,
  component: KitPage,
});

// --- integration catalogue: pick → generated config → test → live check (integration plan I1.0) ---

const integrationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/t/$tenantId/integrations",
  validateSearch: parseIntegrationsSearch,
  component: IntegrationsPage,
});

// --- SCF operator console (operator.global-view-credentials, operator.web-*, operator.api-*) ---

const operatorRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/operator",
  component: OperatorLayout,
});

const operatorIndexRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/",
  component: () => (
    <Navigate
      to="/operator/overview"
      search={{
        range: "30d",
        variant: "verified",
        min_level: "L1",
        awarded: "any",
        band: "any",
        ids: [],
      }}
      replace
    />
  ),
});

const operatorOverviewRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/overview",
  validateSearch: parseOperatorSearch,
  component: OperatorOverviewPage,
});

const operatorWebRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/web",
  validateSearch: parseOpSearch,
  component: OperatorWebPage,
});

const operatorApiRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/api",
  validateSearch: parseOpSearch,
  component: OperatorApiPage,
});

const operatorCohortsRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/cohorts",
  validateSearch: parseCohortSearch,
  component: OperatorCohortsPage,
});

const operatorTenantsRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/tenants",
  validateSearch: parseOperatorTenantsSearch,
  component: OperatorTenantsPage,
});

const operatorTenantRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/tenants/$tenantId",
  component: OperatorTenantPage,
});

const operatorTombstonesRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/tombstones",
  component: OperatorTombstonesPage,
});

const operatorSettingsRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/settings",
  component: OperatorSettingsPage,
});

const operatorKeysRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/api-keys",
  component: OperatorApiKeysPage,
});

const operatorAuditRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/audit",
  validateSearch: parseAuditSearch,
  component: OperatorAuditPage,
});

const operatorCoverageRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/onboarding",
  validateSearch: parseCoverageSearch,
  component: OperatorCoveragePage,
});

// --- Ecosystem Usage Map: on-chain usage of every registry project with contracts ---
const operatorUsageMapRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/usage-map",
  validateSearch: parseUsageMapSearch,
  component: UsageMapPage,
});

const operatorUsageMapProjectRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/usage-map/$registryProjectId",
  validateSearch: parseUsageProjectSearch,
  component: UsageMapProjectPage,
});

const operatorOperatorsRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/operators",
  component: OperatorOperatorsPage,
});

const operatorErasureRoute = createRoute({
  getParentRoute: () => operatorRoute,
  path: "/erasure",
  component: OperatorErasurePage,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  passkeyStepRoute,
  publicStatsRoute,
  verifySnapshotRoute,
  verifyRoute,
  evidenceRoute,
  appRoute.addChildren([
    indexRoute,
    tenantsRoute,
    accountRoute,
    oauthConsentRoute,
    oauthAppsRoute,
    tenantRoute,
    siteRoute.addChildren([
      siteDashboardRoute,
      walletsRoute,
      reportsRoute,
      installationRoute,
      snippetRoute,
      settingsRoute,
      browserRoute,
    ]),
    webIndexRoute,
    walletsIndexRoute,
    appsRoute,
    onchainRoute,
    footprintRoute,
    projectSettingsRoute,
    servicesRoute,
    serviceRoute.addChildren([apiDashboardRoute, otelSetupRoute]),
    tokensRoute,
    snapshotsRoute,
    sharingRoute,
    erasureRoute,
    erasureDetailRoute,
    teamRoute,
    verificationRoute,
    tenantUsageMapRoute,
    tenantProtocolsRoute,
    trustRoute,
    acceptInvitationRoute,
    setupRoute,
    setupWebRoute,
    setupApiRoute,
    setupFootprintRoute,
    onboardRoute,
    kitRoute,
    integrationsRoute,
    operatorRoute.addChildren([
      operatorIndexRoute,
      operatorOverviewRoute,
      operatorWebRoute,
      operatorApiRoute,
      operatorCohortsRoute,
      operatorTenantsRoute,
      operatorTenantRoute,
      operatorTombstonesRoute,
      operatorSettingsRoute,
      operatorKeysRoute,
      operatorAuditRoute,
      operatorErasureRoute,
      operatorOperatorsRoute,
      operatorCoverageRoute,
      operatorUsageMapRoute,
      operatorUsageMapProjectRoute,
      operatorProtocolsRoute,
    ]),
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: false, scrollRestoration: false });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
