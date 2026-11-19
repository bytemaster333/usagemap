// SPDX-License-Identifier: Apache-2.0
// Onboarding steps 2–5 (approved design), personalised with the project's public site key (getIntegrationKit):
//   2. Prove it — sign with Freighter (or any Stellar wallet: verificationStellarChallenge/Verify; the account must be
//      listed in the domain's stellar.toml) or confirm the domain (DNS TXT, /.well-known/ file or meta tag);
//   3. Framework — detected from the registry where possible, plus "my app connects Stellar wallets";
//   4. Your snippet — install line, the framework starter and the wallet adapter, site key filled in;
//   5. First event — the live first-event panel (dev events from localhost are never counted) and a test command;
//      once one arrives: "Open my dashboard" and what to add next.
// Ingest tokens are never shown here: they are created on the Keys page and shown once.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { StellarProof } from "../../auth/components.tsx";
import { useTitle } from "../../components/AppShell.tsx";
import { CopyButton } from "../../components/CopyButton.tsx";
import { FIRST_EVENT_POLL_MS, FirstEventPanel } from "../../components/FirstEventPanel.tsx";
import { ProblemAlert } from "../../components/ProblemAlert.tsx";
import {
  AccessNotice,
  Button,
  buttonClass,
  CodeBlock,
  Field,
  Icon,
  type IconName,
  LoadingState,
  Note,
  StatusBadge,
  Switch,
} from "../../components/ui/index.ts";
import { fmtDayTime } from "../../lib/format.ts";
import { canManage, useMyRole } from "../Team.tsx";
import { cleanHost, FRAMEWORKS, type KitFramework, type KitSearch, type KitStep } from "./model.ts";
import { OnboardFrame, OnboardHead } from "./OnboardFrame.tsx";

type Kit = ControlPlane.IntegrationKit;
type Method = ControlPlane.DomainVerification["method"];

const METHODS: ReadonlyArray<{ id: Method; label: string }> = [
  { id: "dns_txt", label: "DNS TXT record" },
  { id: "well_known", label: "File under /.well-known/" },
  { id: "meta_tag", label: "Meta tag" },
];

const FW_ICON: Record<KitFramework, IconName> = {
  nextjs: "code",
  nuxt: "code",
  sveltekit: "code",
  astro: "code",
  react_spa: "code",
  html: "code",
  nocode: "pointer",
  other: "sparkle",
};

const STEP_NUM: Record<KitStep, number> = { prove: 2, framework: 3, snippet: 4, first: 5 };

function KitCode({ c, testId }: { c: ControlPlane.KitCode; testId?: string }) {
  return (
    <>
      {c.install ? (
        <CodeBlock title="Terminal" code={c.install} copyLabel="Copy install command" />
      ) : null}
      <CodeBlock
        title={c.filename ? `${c.title} · ${c.filename}` : c.title}
        code={c.code}
        testId={testId}
      />
      {c.guide_path ? (
        <p className="um-p-fine">
          Guide: <code>{c.guide_path}</code>
        </p>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ step 2: prove it

function DomainProof({
  tenantId,
  site,
  onChange,
}: {
  tenantId: string;
  site: NonNullable<Kit["site"]>;
  onChange: () => void;
}) {
  const [host, setHost] = useState("");
  const [v, setV] = useState<ControlPlane.DomainVerification | null>(null);
  const domain = site.domains.find((d) => d.state !== "verified") ?? site.domains[0];
  const path = { tenantId, siteId: site.site_id };
  const add = useMutation({
    mutationFn: () => api.call("addDomain", { path, body: { host: cleanHost(host) } }),
    onSuccess: onChange,
  });
  const start = useMutation({
    mutationFn: (method: Method) =>
      api.call("startDomainVerification", {
        path: { ...path, domainId: domain?.domain_id as string },
        body: { method },
      }),
    onSuccess: setV,
  });
  const check = useMutation({
    mutationFn: (x: ControlPlane.DomainVerification) =>
      api.call("checkDomainVerification", {
        path: { ...path, domainId: domain?.domain_id as string, verificationId: x.verification_id },
      }),
    onSuccess: (x) => {
      setV(x);
      onChange();
    },
  });
  if (!domain)
    return (
      <form
        className="um-p-inlineform"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="Your production domain">
          <input
            className="um-inp um-inp--mono"
            required
            placeholder="example.org"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </Field>
        <Button type="submit" size="sm" disabled={add.isPending}>
          Add domain
        </Button>
        <ProblemAlert error={add.error} />
      </form>
    );
  if (domain.state === "verified")
    return (
      <Note tone="good">
        <p role="status" data-testid="kit-domain-verified">
          <b>{domain.host}</b> is verified. Ownership confirmed.
        </p>
      </Note>
    );
  const i = v?.instructions;
  return (
    <div className="um-p-stack um-p-gap10">
      <p>
        Prove that you control <b>{domain.host}</b> — pick the easiest:
      </p>
      <div className="um-p-tools">
        {METHODS.map((m) => (
          <Button
            key={m.id}
            size="sm"
            variant={v?.method === m.id ? "primary" : "secondary"}
            onClick={() => start.mutate(m.id)}
            disabled={start.isPending}
          >
            {m.label}
          </Button>
        ))}
      </div>
      {v && i ? (
        <div className="um-p-stack um-p-gap10" data-testid="kit-verification">
          {v.method === "dns_txt" ? (
            <>
              <CodeBlock
                title={`DNS · TXT · ${i.dns_name ?? ""}`}
                code={i.dns_value ?? ""}
                copyLabel="Copy value"
              />
              <p className="um-p-fine">
                Record name <code>{i.dns_name}</code>{" "}
                <CopyButton text={i.dns_name ?? ""} label="Copy name" />
              </p>
            </>
          ) : null}
          {v.method === "well_known" ? (
            <>
              <p className="um-p-fine">
                Serve <code>{i.url}</code> with exactly this content:
              </p>
              <CodeBlock
                title={i.url ?? "file"}
                code={i.file_body ?? ""}
                copyLabel="Copy file content"
              />
            </>
          ) : null}
          {v.method === "meta_tag" ? (
            <CodeBlock
              title="Inside <head> of your home page"
              code={i.meta_tag ?? ""}
              copyLabel="Copy meta tag"
            />
          ) : null}
          <div className="um-p-tools">
            <Button
              size="sm"
              icon="repeat"
              onClick={() => check.mutate(v)}
              disabled={check.isPending}
            >
              Check now
            </Button>
            <span className="um-p-fine">
              Status: <b data-testid="kit-verification-status">{v.status}</b>
              {v.last_result_code ? ` (last check: ${v.last_result_code})` : ""}. DNS can take up to
              an hour; we also check by ourselves every few minutes.
            </span>
          </div>
        </div>
      ) : null}
      <ProblemAlert error={start.error ?? check.error} />
    </div>
  );
}

function ProveStep({ tenantId, kit, onNext }: { tenantId: string; kit: Kit; onNext: () => void }) {
  const qc = useQueryClient();
  const role = useMyRole(tenantId);
  const [proof, setProof] = useState<"wallet" | "domain">("wallet");
  const [linked, setLinked] = useState<string | null>(null);
  const domain = kit.site?.domains[0]?.host ?? kit.registry_project?.domain ?? "your domain";
  const domainOk = kit.site?.domains.some((d) => d.state === "verified") ?? false;
  const proven = !!linked || domainOk;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["kit", tenantId] });
  return (
    <>
      <OnboardHead
        label="Step 2 of 5"
        title={`Prove ${kit.registry_project?.name ?? "this project"} is yours`}
      >
        Pick one. Either is enough to open your private dashboard.
      </OnboardHead>
      <div className="um-onb-proof" role="radiogroup" aria-label="How to prove it">
        {/* biome-ignore lint/a11y/useSemanticElements: a card-sized radio with a title, a description and an icon */}
        <button
          type="button"
          role="radio"
          aria-checked={proof === "wallet"}
          className="um-p-opt um-onb-opt"
          onClick={() => setProof("wallet")}
        >
          <span className="um-tile um-tile--lg um-tone-wallet">
            <Icon name="freighter" />
          </span>
          <span>
            <b>Sign with Freighter</b>
            <small>
              Your account must be listed in {domain}/.well-known/stellar.toml. Free, moves no
              funds. Any Stellar wallet works.
            </small>
          </span>
          <span className="um-p-rd" aria-hidden="true" />
        </button>
        {/* biome-ignore lint/a11y/useSemanticElements: a card-sized radio with a title, a description and an icon */}
        <button
          type="button"
          role="radio"
          aria-checked={proof === "domain"}
          className="um-p-opt um-onb-opt"
          onClick={() => setProof("domain")}
        >
          <span className="um-tile um-tile--lg um-tone-web">
            <Icon name="globe" />
          </span>
          <span>
            <b>Confirm your domain</b>
            <small>
              Add a DNS TXT record, a file under /.well-known/ or a meta tag. Takes a few minutes.
            </small>
          </span>
          <span className="um-p-rd" aria-hidden="true" />
        </button>
      </div>
      <div className="um-onb-card">
        {proof === "wallet" ? (
          linked ? (
            <Note tone="good">
              <p data-testid="linked">
                <b>Signed.</b> <code>{linked}</code> is listed in {domain}'s stellar.toml. Ownership
                confirmed.
              </p>
            </Note>
          ) : canManage(role) ? (
            <>
              <StellarProof
                accountLabel="Project's Stellar account"
                walletLabel="Sign with"
                submitLabel="Link account"
                requestChallenge={(account, method) =>
                  api.call("verificationStellarChallenge", {
                    path: { tenantId },
                    body: { account, method },
                  })
                }
                submit={async (body, account) => {
                  const next = await api.call("verificationStellarVerify", {
                    path: { tenantId },
                    body,
                  });
                  qc.setQueryData(["verification", tenantId], next);
                  setLinked(account);
                  refresh();
                  await qc.invalidateQueries({ queryKey: ["tenants"] });
                }}
              />
              <p className="um-p-fine">
                <Icon name="info" size="xs" /> The message carries a one-time code. Nothing is sent
                to the network. The account's <code>home_domain</code> must be a verified domain of
                this project — no wallet?{" "}
                <button type="button" className="um-onb-quiet" onClick={() => setProof("domain")}>
                  Confirm your domain instead
                </button>
              </p>
            </>
          ) : (
            <AccessNotice kind="read-only" />
          )
        ) : kit.site ? (
          <DomainProof tenantId={tenantId} site={kit.site} onChange={refresh} />
        ) : (
          <p className="um-muted">
            This project has no website yet: add one in Settings → Websites.
          </p>
        )}
      </div>
      <div className="um-onb-f">
        <span className="um-p-fine">
          {proven ? "" : "You can come back to this later from Trust."}
        </span>
        <Button variant="primary" iconAfter="arrow" onClick={onNext}>
          {proven ? "Continue" : "Continue for now"}
        </Button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ step 3: framework

function FrameworkStep({
  kit,
  dapp,
  onFramework,
  onDapp,
  onBack,
  onNext,
}: {
  kit: Kit;
  dapp: boolean;
  onFramework: (f: KitFramework) => void;
  onDapp: (v: boolean) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const detected = kit.framework.detected.framework;
  const domain = kit.site?.domains[0]?.host ?? kit.registry_project?.domain;
  return (
    <>
      <OnboardHead label="Step 3 of 5" title="What is your site built with?">
        {detected && domain
          ? `We looked at ${domain}: it looks like ${FRAMEWORKS.find((f) => f.id === detected)?.label ?? detected}. Change it if we're wrong.`
          : "Pick the closest match; every option gives you a working snippet."}
      </OnboardHead>
      <div className="um-onb-fw" role="radiogroup" aria-label="What is your website built with?">
        {FRAMEWORKS.map((f) => (
          // biome-ignore lint/a11y/useSemanticElements: a card-sized radio with a title, a description and an icon
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={kit.framework.selected === f.id}
            onClick={() => onFramework(f.id)}
          >
            <span className="um-onb-fwi">
              <Icon name={FW_ICON[f.id]} size="sm" />
            </span>
            <b>{f.label}</b>
            {detected === f.id ? <span className="um-onb-det">Detected</span> : null}
          </button>
        ))}
      </div>
      {kit.framework.detected.basis ? (
        <p className="um-p-fine">Detected from: {kit.framework.detected.basis}.</p>
      ) : null}
      <div className="um-onb-card">
        <div className="um-p-setrow">
          <div className="um-onb-dapp">
            <span className="um-tile um-tone-wallet">
              <Icon name="wallet" />
            </span>
            <div>
              <b>My app connects Stellar wallets</b>
              <small>
                Adds connect, signature and failure counts.
                {kit.wallets.recommended ? " The registry suggests this is a dApp." : ""}
              </small>
            </div>
          </div>
          <Switch
            label="My app connects Stellar wallets"
            checked={dapp}
            onChange={onDapp}
            onText="Yes"
            offText="No"
          />
        </div>
      </div>
      <div className="um-onb-f">
        <Button variant="ghost" icon="back" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" iconAfter="arrow" onClick={onNext}>
          Get my snippet
        </Button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ step 4: snippet

function SnippetStep({
  kit,
  dapp,
  onBack,
  onNext,
}: {
  kit: Kit;
  dapp: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  const domain = kit.site?.domains[0]?.host ?? kit.site?.name ?? "your site";
  return (
    <>
      <OnboardHead label="Step 4 of 5" title="Your snippet is ready">
        Made for {domain}, with your site key already in it.
      </OnboardHead>
      <div className="um-onb-card">
        {!kit.site ? (
          <p className="um-muted">
            This project has no website yet: add one in Settings → Websites.
          </p>
        ) : (
          <>
            <span className="um-label">1 · Add it once</span>
            {kit.framework_snippet ? (
              <KitCode c={kit.framework_snippet} testId="kit-framework-snippet" />
            ) : kit.script_tag ? (
              <KitCode c={kit.script_tag} testId="kit-script-tag" />
            ) : null}
            {kit.script_tag &&
            kit.framework_snippet &&
            kit.framework_snippet.code !== kit.script_tag.code ? (
              <details className="um-p-details">
                <summary>Or the plain script tag</summary>
                <KitCode c={kit.script_tag} testId="kit-script-tag" />
              </details>
            ) : null}
            {dapp && kit.wallets.snippets.length > 0 ? (
              <>
                <span className="um-label">2 · Wallets</span>
                {kit.wallets.snippets.map((c) => (
                  <KitCode key={c.title} c={c} />
                ))}
              </>
            ) : null}
            <p className="um-p-fine">
              Your site key <code data-testid="kit-site-key">{kit.site.site_key}</code> is public:
              it is in every page that loads the tracker
              {kit.tracker_version
                ? ` (tracker ${kit.tracker_version}, pinned with an integrity hash)`
                : ""}
              .
            </p>
          </>
        )}
      </div>
      <Note icon="shield">
        <p>
          localhost is allowed as a dev origin, so you can test before you deploy. Dev events are
          never counted.
        </p>
      </Note>
      <div className="um-onb-f">
        <Button variant="ghost" icon="back" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" iconAfter="arrow" onClick={onNext}>
          I added it
        </Button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ step 5: first event

function FirstStep({
  tenantId,
  kit,
  site,
  onBack,
}: {
  tenantId: string;
  kit: Kit;
  site: ControlPlane.Site;
  onBack: () => void;
}) {
  const dev = useQuery({
    queryKey: ["dev-events", tenantId, site.site_id],
    queryFn: () => api.call("listSiteDevEvents", { path: { tenantId, siteId: site.site_id } }),
    refetchInterval: FIRST_EVENT_POLL_MS,
  });
  const events = dev.data?.events ?? [];
  const got = events.length > 0;
  const domain = kit.site?.domains[0]?.host ?? site.name;
  return (
    <>
      {got ? (
        <div className="um-onb-card" data-testid="first-event-arrived">
          <div className="um-onb-celebrate">
            <span className="um-onb-ok">
              <Icon name="check" size="lg" />
            </span>
            <h2 className="um-h2">Your first event arrived</h2>
            <p className="um-muted">
              The same view on {domain} will count once it passes every check. Events from dev
              origins are never counted.
            </p>
            <ul className="um-onb-evl">
              {events.slice(0, 4).map((e) => (
                <li key={`${e.received_at}${e.path}${e.event_name}`}>
                  <time>{fmtDayTime(e.received_at)}</time>
                  <code>
                    {e.kind === "pageview" ? "page view" : e.event_name} · {e.path}
                  </code>
                  <StatusBadge
                    status={
                      e.would_be_verdict === "verified"
                        ? "live"
                        : e.would_be_verdict === "suspect"
                          ? "wait"
                          : "bad"
                    }
                  >
                    Would be {e.would_be_verdict}
                  </StatusBadge>
                </li>
              ))}
            </ul>
            <Link
              to="/t/$tenantId"
              params={{ tenantId }}
              search={{}}
              className={buttonClass("highlight")}
            >
              Open my dashboard
              <Icon name="arrow" />
            </Link>
          </div>
        </div>
      ) : (
        <OnboardHead label="Step 5 of 5" title="See your first event arrive">
          Run your app on localhost and open any page. This screen updates by itself.
        </OnboardHead>
      )}
      {got ? (
        <div className="um-onb-next">
          <Link to="/t/$tenantId/integrations" params={{ tenantId }} search={{ group: "api" }}>
            <span className="um-tile um-tone-api">
              <Icon name="server" />
            </span>
            <b>Add your API</b>
            <small>OpenTelemetry, about 5 minutes</small>
          </Link>
          <Link to="/t/$tenantId/footprint" params={{ tenantId }}>
            <span className="um-tile um-tone-chain">
              <Icon name="layers" />
            </span>
            <b>Register contracts</b>
            <small>
              {kit.contracts.length > 0
                ? `${kit.contracts.length} found in the registry`
                : "Your contracts and accounts"}
            </small>
          </Link>
          <Link to="/t/$tenantId/team" params={{ tenantId }}>
            <span className="um-tile um-tone-neutral">
              <Icon name="users" />
            </span>
            <b>Invite your team</b>
            <small>They see what you see</small>
          </Link>
        </div>
      ) : (
        <div className="um-onb-first">
          <div className="um-onb-card">
            <FirstEventPanel tenantId={tenantId} site={site} />
          </div>
          <div className="um-onb-card">
            <span className="um-label">Nothing yet? Check these</span>
            <ul className="um-p-mlist">
              <li>
                <Icon name="check" size="sm" />
                <span>The app is running and you opened a page in the browser.</span>
              </li>
              <li>
                <Icon name="check" size="sm" />
                <span>An ad blocker can stop it on localhost. Try a private window.</span>
              </li>
              <li>
                <Icon name="check" size="sm" />
                <span>Or send a test from the terminal:</span>
              </li>
            </ul>
            {kit.test_commands[0] ? <KitCode c={kit.test_commands[0]} /> : null}
          </div>
        </div>
      )}
      <div className="um-onb-f">
        <Button variant="ghost" icon="back" onClick={onBack}>
          Back
        </Button>
        {got ? null : (
          <Link className="um-onb-quiet" to="/t/$tenantId" params={{ tenantId }} search={{}}>
            Go to my dashboard
          </Link>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ page

export function KitPage() {
  const { tenantId } = useParams({ from: "/app/t/$tenantId/onboard/kit" });
  const search = useSearch({ from: "/app/t/$tenantId/onboard/kit" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const step = search.step ?? "prove";
  useTitle("Set up your project");
  const kit = useQuery({
    queryKey: ["kit", tenantId, search.site ?? null, search.framework ?? null],
    queryFn: () =>
      api.call("getIntegrationKit", {
        path: { tenantId },
        query: {
          ...(search.site ? { site_id: search.site } : {}),
          ...(search.framework ? { framework: search.framework } : {}),
        },
      }),
  });
  const k = kit.data;
  const siteId = k?.site?.site_id;
  const site = useQuery({
    queryKey: ["site", tenantId, siteId],
    queryFn: () => api.call("getSite", { path: { tenantId, siteId: siteId as string } }),
    enabled: !!siteId,
  });
  const warnings = qc.getQueryData<string[]>(["enrol-warnings", tenantId]) ?? [];
  const set = (patch: { [K in keyof KitSearch]?: KitSearch[K] | undefined }) => {
    const next: Record<string, unknown> = { ...search, ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    void navigate({
      to: "/t/$tenantId/onboard/kit",
      params: { tenantId },
      search: next as KitSearch,
      replace: patch.step === undefined,
    });
  };
  const dapp = search.dapp ?? k?.wallets.recommended ?? false;
  const goto = (n: number) => {
    const s = (["prove", "framework", "snippet", "first"] as const)[n - 2];
    if (n === 1) void navigate({ to: "/onboard", search: {} });
    else if (s) set({ step: s });
  };
  return (
    <OnboardFrame step={STEP_NUM[step]} onStep={goto}>
      {warnings.length > 0 ? (
        <Note tone="warn">
          <p>
            The project was created, but some steps did not complete: {warnings.join("; ")}. You can
            finish them in Settings.
          </p>
        </Note>
      ) : null}
      <ProblemAlert error={kit.error} />
      {!k ? (
        kit.isPending ? (
          <LoadingState block label="Preparing your kit…" />
        ) : null
      ) : step === "prove" ? (
        <ProveStep tenantId={tenantId} kit={k} onNext={() => set({ step: "framework" })} />
      ) : step === "framework" ? (
        <FrameworkStep
          kit={k}
          dapp={dapp}
          onFramework={(framework) => set({ framework })}
          onDapp={(v) => set({ dapp: v || undefined })}
          onBack={() => set({ step: "prove" })}
          onNext={() => set({ step: "snippet", framework: k.framework.selected })}
        />
      ) : step === "snippet" ? (
        <SnippetStep
          kit={k}
          dapp={dapp}
          onBack={() => set({ step: "framework" })}
          onNext={() => set({ step: "first" })}
        />
      ) : site.data ? (
        <FirstStep
          tenantId={tenantId}
          kit={k}
          site={site.data}
          onBack={() => set({ step: "snippet" })}
        />
      ) : k.site ? (
        <LoadingState block />
      ) : (
        <p className="um-muted">This project has no website yet: add one in Settings → Websites.</p>
      )}
    </OnboardFrame>
  );
}
