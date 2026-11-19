# Footprint registration from a deploy script

A deploy script registers the contract it just deployed with UsageMap's Registered Footprint, as `claimed`, with a
scoped **footprint registration key** (`scfa_reg_…`). That key can add contracts to one project and nothing else: it
cannot verify, remove or read anything, and no portal session is needed. You still prove ownership on the portal, and
only verified contracts are counted. Guide: [Register your footprint](../../docs/onboarding/footprint.md#register-from-your-deploy-script-scaffold-stellar).

## Run it

1. **Install:** nothing to install: `register.sh` needs `bash` and `curl` (`cd examples/footprint-register`).
2. **Set your key:** portal **Footprint** → create a registration key (admin or owner; optionally limited to one
   network), then `export SCF_FOOTPRINT_KEY=scfa_reg_…` and `export USAGEMAP_TENANT_ID=<project id>` (shown on the same
   page). For a local stack also `export USAGEMAP_API_URL=http://localhost:<port>`.
3. **Run:** `./register.sh <your contract id C…> testnet my-contract` → `HTTP/1.1 201` with the new item
   (`"status":"claimed"`); `409` means it was already declared, which is fine.

## The lines that add UsageMap

`register.sh`:

```sh
body="{\"kind\":\"contract\",\"subject\":\"$contract\",\"network\":\"$network\""
[ -n "$label" ] && body="$body,\"label\":\"$label\""
body="$body}"
```

`register.sh`:

```sh
curl -sS -i --max-redirs 0 -X POST "$api/v1/tenants/$tenant/footprint/register" \
  -H @<(printf 'Authorization: Bearer %s\n' "$key") \
  -H 'Content-Type: application/json' \
  --data "$body"
```

The script refuses anything that is not a contract id (`C…`, 56 characters) before sending: declare only contracts
your project controls, never a user's address. The key is passed to curl on a file descriptor, never on the command
line.

## What you'll see in the portal

**Footprint**: the contract appears with status `claimed`. After you prove that the deploying or admin account is
yours (**Verification → Stellar account**), the ledger check turns it `verified`, usually within minutes, and its
daily invocations, successful invocations and distinct invokers are counted next to your web and API numbers.
Testnet and mainnet are counted separately. The audit log records `footprint.item_added` by `footprint_key:<key id>`.

## Test it without the app

```sh
curl -sS -i -X POST "https://app.usagemap.dev/v1/tenants/$USAGEMAP_TENANT_ID/footprint/register" \
  -H "Authorization: Bearer $SCF_FOOTPRINT_KEY" -H 'Content-Type: application/json' \
  --data '{"kind":"contract","subject":"<your contract id C…>","network":"testnet","label":"my-contract"}'
# → 201 (claimed) · 409 already declared · 401 key revoked · 403 key bound to the other network · 404 other project
```

## Tested by

`tests/quickstarts/integrations/tools.spec.ts` (`footprint-register`): runs `register.sh` against a local stand-in of
the control plane and checks the request against the `registerFootprintContract` operation of
`docs/api/control-plane.openapi.yaml`: `POST /v1/tenants/{tenantId}/footprint/register`, `Authorization: Bearer
scfa_reg_…`, `Content-Type: application/json`, no cookie, and a body with exactly the `FootprintRegistration`
properties (`kind`, `subject` matching `^C[A-Z2-7]{55}$`, `network`, `label`). It also checks that an account address
(`G…`), an ingest token instead of a registration key and a non-https API URL are refused before anything is sent,
and that the key never appears in the script's arguments or output. **Not run:** the real control plane (the
endpoint's own tests are in `services/control-plane`).
