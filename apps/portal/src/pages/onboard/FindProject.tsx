// SPDX-License-Identifier: Apache-2.0
// Onboarding step 1, "Find your project" (approved design): search the public Stellar registries (SCF awards,
// Stellarlight, PG Atlas — synced nightly); any project built on Stellar can enroll. Picking a project pre-fills the
// name, short name, website and the contracts the registry lists; continuing creates the project (createTenant →
// createSite → addDomain → addFootprintItem) and opens step 2, "Prove it". The pre-fill grants nothing: the project
// proves its claim next (Freighter signature or domain). A project another team already holds is shown as claimed:
// enrolling anyway is allowed and an SCF operator decides. "Not in the list?" starts without the registry.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ControlPlane } from "@usagemap/api-types";
import { useEffect, useState } from "react";
import { api } from "../../api/client.ts";
import { useTenants, useTitle } from "../../components/AppShell.tsx";
import { ProblemAlert } from "../../components/ProblemAlert.tsx";
import {
  Button,
  Field,
  Icon,
  LoadingState,
  Note,
  StatusBadge,
  Tag,
} from "../../components/ui/index.ts";
import { slugify } from "../Tenants.tsx";
import { CATEGORY_TEXT, type EnrolStep, enrol, STAGE_TEXT } from "./model.ts";
import { OnboardFrame, OnboardHead } from "./OnboardFrame.tsx";

const STEP_TEXT: Record<EnrolStep, string> = {
  project: "Creating the project…",
  website: "Adding the website…",
  domain: "Declaring the domain…",
  contracts: "Registering the contracts…",
};

/** Debounced value (the picker searches after typing pauses). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ProjectFacts({ p }: { p: ControlPlane.RegistryProjectSummary }) {
  return (
    <span className="um-onb-meta">
      {p.domain ? <code>{p.domain}</code> : null}
      {p.award_round !== null ? <Tag>Round {p.award_round}</Tag> : null}
      {p.award_stage ? <Tag>{STAGE_TEXT[p.award_stage]}</Tag> : null}
      {p.categories.slice(0, 1).map((c) => (
        <span key={c}>{CATEGORY_TEXT[c]}</span>
      ))}
    </span>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="um-onb-hit">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function Results({
  q,
  picked,
  onPick,
}: {
  q: string;
  picked: string | undefined;
  onPick: (id: string) => void;
}) {
  const results = useQuery({
    queryKey: ["registry-search", q],
    queryFn: () => api.call("searchRegistryProjects", { query: { q, limit: 8 } }),
    enabled: q.length >= 2,
    staleTime: 60_000,
  });
  if (q.length < 2)
    return <p className="um-p-fine">Type at least 2 characters of the name or website.</p>;
  if (results.error) return <ProblemAlert error={results.error} />;
  if (!results.data) return <LoadingState label="Searching the registries…" />;
  if (results.data.items.length === 0)
    return (
      <p role="status" className="um-muted">
        No listed project matches “{q}”. Not listed yet? Start without the registry below — the
        registry match can follow later.
      </p>
    );
  return (
    <>
      <ul className="um-onb-reg" aria-label="Matching projects" data-testid="registry-results">
        {results.data.items.map((p) => {
          const on = picked === p.registry_project_id;
          return (
            <li key={p.registry_project_id}>
              <button type="button" aria-pressed={on} onClick={() => onPick(p.registry_project_id)}>
                <span className="um-onb-pav" aria-hidden="true">
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="um-onb-reg-t">
                  <b>
                    <span className="um-sr">Select </span>
                    <Highlight text={p.name} q={q} />
                  </b>
                  <ProjectFacts p={p} />
                </span>
                {on ? <StatusBadge status="wait">Selected</StatusBadge> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {results.data.more ? (
        <p className="um-p-fine">More projects match — type more of the name.</p>
      ) : null}
    </>
  );
}

function ClaimBanner({ claim }: { claim: ControlPlane.RegistryPrefill["claim"] }) {
  if (claim.state === "yours")
    return (
      <Note tone="good">
        <p role="status" data-testid="claim-yours">
          <b>You already have this project.</b>{" "}
          {claim.your_tenant_ids.map((t) => (
            <Link
              key={t}
              className="um-link"
              to="/t/$tenantId"
              params={{ tenantId: t }}
              search={{}}
            >
              Open its dashboard
            </Link>
          ))}
        </p>
      </Note>
    );
  if (claim.state === "claimed")
    return (
      <Note tone="warn">
        <p role="status" data-testid="claim-claimed">
          <b>Already claimed — dispute.</b> Another project on this platform has already proved
          control of this project's website or was matched to it. If it is yours, you can still
          enrol: verifying the same domain opens a dispute that an SCF operator decides. Your data
          stays separate either way.
        </p>
      </Note>
    );
  return null;
}

function useEnrol() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<EnrolStep | null>(null);
  const m = useMutation({
    mutationFn: (input: {
      name: string;
      slug: string;
      domain: string;
      contracts: string[];
      dapp: boolean;
    }) =>
      enrol(
        {
          createTenant: (body) => api.call("createTenant", { body }),
          createSite: (tenantId, body) => api.call("createSite", { path: { tenantId }, body }),
          addDomain: (tenantId, siteId, host) =>
            api.call("addDomain", { path: { tenantId, siteId }, body: { host } }),
          addContract: (tenantId, subject) =>
            api.call("addFootprintItem", {
              path: { tenantId },
              body: { kind: "contract", subject, network: "mainnet" },
            }),
        },
        {
          name: input.name.trim(),
          slug: input.slug,
          siteName: input.domain.trim() || input.name.trim(),
          domain: input.domain,
          contracts: input.contracts,
        },
        setStep,
      ).then((r) => ({ ...r, dapp: input.dapp })),
    onSuccess: async (r) => {
      // steps that failed after the project existed: shown once on the next step (nothing is undone)
      qc.setQueryData(["enrol-warnings", r.tenantId], r.warnings);
      await qc.invalidateQueries({ queryKey: ["tenants"] });
      void navigate({
        to: "/t/$tenantId/onboard/kit",
        params: { tenantId: r.tenantId },
        search: {
          ...(r.siteId ? { site: r.siteId } : {}),
          step: "prove",
          ...(r.dapp ? { dapp: true } : {}),
        },
      });
    },
    onSettled: () => setStep(null),
  });
  return { ...m, step };
}

function Selected({ projectId }: { projectId: string }) {
  const pre = useQuery({
    queryKey: ["registry-prefill", projectId],
    queryFn: () =>
      api.call("getRegistryProjectPrefill", { path: { registryProjectId: projectId } }),
  });
  const d = pre.data;
  const create = useEnrol();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [domain, setDomain] = useState("");
  const [contracts, setContracts] = useState<string[]>([]);
  const [dispute, setDispute] = useState(false);
  useEffect(() => {
    if (!d) return;
    setName(d.prefill.tenant_name);
    setSlug(d.prefill.slug);
    setDomain(d.prefill.site_domain ?? "");
    setContracts(d.prefill.contracts.map((c) => c.contract_id));
  }, [d]);
  if (pre.error) return <ProblemAlert error={pre.error} />;
  if (!d) return <LoadingState />;
  const claimed = d.claim.state === "claimed";
  return (
    <section
      className="um-onb-sel"
      data-testid="selected-project"
      aria-label={`Selected: ${d.project.name}`}
    >
      <div className="um-onb-sel-h">
        <b>{d.project.name}</b>
        <ProjectFacts p={d.project} />
        {d.links.websites.length > 0 ? (
          <span className="um-p-fine">Website: {d.links.websites.join(", ")}</span>
        ) : null}
      </div>
      <ClaimBanner claim={d.claim} />
      {d.claim.state === "yours" ? null : (
        <form
          id="onb-create"
          className="um-p-form"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name, slug, domain, contracts, dapp: d.is_dapp });
          }}
        >
          <p className="um-p-fine">
            Pre-filled from the registry. Nothing here is trusted until you prove it in the next
            step.
          </p>
          <div className="um-grid um-g3">
            <Field label="Project name">
              <input
                className="um-inp"
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Short name (used in links)">
              <input
                className="um-inp um-inp--mono"
                required
                pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
                maxLength={40}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
            </Field>
            <Field label="Production website domain">
              <input
                className="um-inp um-inp--mono"
                value={domain}
                placeholder="example.org"
                autoComplete="off"
                onChange={(e) => setDomain(e.target.value)}
              />
            </Field>
          </div>
          {d.prefill.contracts.length > 0 ? (
            <fieldset className="um-p-fieldset">
              <legend>Contracts the registry lists (registered as claimed, mainnet)</legend>
              {d.prefill.contracts.map((c) => (
                <label key={c.contract_id} className="um-p-check">
                  <input
                    type="checkbox"
                    checked={contracts.includes(c.contract_id)}
                    onChange={(e) =>
                      setContracts((xs) =>
                        e.target.checked
                          ? [...xs, c.contract_id]
                          : xs.filter((x) => x !== c.contract_id),
                      )
                    }
                  />
                  <code>{c.contract_id}</code>
                </label>
              ))}
            </fieldset>
          ) : null}
          {claimed ? (
            <label className="um-p-check">
              <input
                type="checkbox"
                checked={dispute}
                onChange={(e) => setDispute(e.target.checked)}
              />
              This is my project; enrol anyway and let an SCF operator decide
            </label>
          ) : null}
          <ProblemAlert error={create.error} />
          {create.step ? (
            <p role="status" className="um-p-fine">
              {STEP_TEXT[create.step]}
            </p>
          ) : null}
          <div className="um-onb-f">
            <span />
            <Button
              type="submit"
              variant="primary"
              iconAfter="arrow"
              disabled={create.isPending || (claimed && !dispute)}
            >
              Continue with {d.project.name}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function WithoutRegistry() {
  const create = useEnrol();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  return (
    <form
      className="um-onb-card"
      aria-label="Start without the registry"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate({ name, slug: slugify(name), domain, contracts: [], dapp: false });
      }}
    >
      <h2 className="um-h2">Start without the registry</h2>
      <p className="um-p-fine">
        Any project built on Stellar can enroll. The registry match can follow later, once your
        domain is verified.
      </p>
      <div className="um-grid um-g2">
        <Field label="Your project's name">
          <input
            className="um-inp"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Your website domain">
          <input
            className="um-inp um-inp--mono"
            value={domain}
            placeholder="example.org"
            autoComplete="off"
            onChange={(e) => setDomain(e.target.value)}
          />
        </Field>
      </div>
      <ProblemAlert error={create.error} />
      {create.step ? (
        <p role="status" className="um-p-fine">
          {STEP_TEXT[create.step]}
        </p>
      ) : null}
      <div className="um-onb-f">
        <span />
        <Button
          type="submit"
          variant="primary"
          iconAfter="arrow"
          disabled={create.isPending || slugify(name).length < 3}
        >
          Create my project
        </Button>
      </div>
    </form>
  );
}

export function FindProjectPage() {
  useTitle("Find your project");
  const search = useSearch({ from: "/app/onboard" });
  const navigate = useNavigate();
  const tenants = useTenants();
  const fresh = (tenants.data?.length ?? 0) === 0;
  const [text, setText] = useState(search.q ?? "");
  const q = useDebounced(text.trim(), 250);
  const [manual, setManual] = useState(false);
  const pick = (project?: string) =>
    void navigate({
      to: "/onboard",
      search: { ...(project ? { project } : {}), ...(text.trim() ? { q: text.trim() } : {}) },
      replace: true,
    });
  return (
    <OnboardFrame step={1}>
      <OnboardHead
        label={fresh ? "Signed in · step 1 of 5" : "Claim another project · step 1 of 5"}
        title={fresh ? "Welcome. Find your project" : "Find your project"}
      >
        {fresh ? "Your account has no project yet. " : ""}Search the Stellar registries (SCF awards,
        Stellarlight, PG Atlas). We fill in your name, website and contracts from the registry. Any
        project built on Stellar can enroll.
      </OnboardHead>
      <div className="um-onb-card">
        <label className="um-p-search um-onb-search">
          <Icon name="search" size="sm" />
          <span className="um-sr">Project name or website</span>
          <input
            type="search"
            autoComplete="off"
            maxLength={80}
            value={text}
            placeholder="Project name or website"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <Results q={q} picked={search.project} onPick={(id) => pick(id)} />
        {search.project ? <Selected key={search.project} projectId={search.project} /> : null}
        <p className="um-p-fine">
          Sources: Stellarlight, the PG Atlas and SCF awards, refreshed daily. Claimed by someone
          else by mistake? Continue anyway: an SCF operator reviews it. Joining a team instead?{" "}
          <Link className="um-link" to="/invitations/accept">
            Accept an invitation
          </Link>
        </p>
      </div>
      {!search.project ? (
        <div className="um-onb-f">
          <button
            type="button"
            className="um-onb-quiet"
            aria-expanded={manual}
            onClick={() => setManual((v) => !v)}
          >
            Not in the list? Start without the registry
          </button>
          <Button variant="primary" iconAfter="arrow" disabled>
            Pick your project
          </Button>
        </div>
      ) : null}
      {manual && !search.project ? <WithoutRegistry /> : null}
    </OnboardFrame>
  );
}
