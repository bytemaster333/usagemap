# MCP server: UsageMap in your AI assistant

> **Status:** the hosted endpoint `https://app.usagemap.dev/mcp` works with a share key or an operator key. OAuth
> sign-in (below) is built but not yet switched on for usagemap.dev; until it is, use a key. The local server
> (`tools/mcp`, example `examples/mcp-claude`) runs from a clone of the repository.

UsageMap runs a **read-only Model Context Protocol (MCP) server** so an AI assistant such as Claude, Cursor or VS Code
can answer questions like "how many verified visitors did our wallet have last month?" or "which SCF-funded projects
have real API traffic?". The assistant sees what you would see in the portal or the API, through your own key.

There are two ways to run it. Both have the same tools.

| | Hosted (recommended) | Local |
|---|---|---|
| Where | `https://app.usagemap.dev/mcp` | on your machine, `tools/mcp/run serve` (stdio) |
| Transport | MCP Streamable HTTP | stdio |
| Key | sent with every request as `Authorization: Bearer …` | read from a file (`USAGEMAP_OPERATOR_KEY_FILE`, `USAGEMAP_SHARE_KEY_FILE`) |
| Install | nothing | a clone of the repository and Node.js 24 |

Protocol versions: **2026-07-28** (stateless, per-request version) and **2025-11-25** (with older `initialize`
clients, back to 2025-03-26).

## Which key to use

The server has no key of its own and no access of its own. Every tool call goes to the UsageMap API **with your key**,
and the API decides what the key may read. The rules are the same as in the portal.

- **Project teams: a share key** (`scfa_pub_…`). Create one in the portal under **Sharing → Share keys**
  (`/t/<your project>/sharing`). A share key is read-only. It opens your own project's metrics document and nothing
  else, so the assistant cannot see another project.
- **SCF operators: an operator key** (`scfa_op_…`), created under **Operator → API keys**. Its scopes
  (`registry:read`, `web:read`, `api:read`) decide which tools appear. If the key is restricted to some projects, the
  tools return only those projects.
- **Ingest tokens** (`scfa_ing_…`) can only write telemetry. The MCP server refuses them.

Keep the key out of shared config files. Use an environment variable or your client's secret prompt, as in the
examples below. Never put a key in a URL. UsageMap refuses any request that has a key in its URL. If that happens,
treat the key as leaked and revoke it in the portal.

## Tools

All tools are read-only. They change nothing, and every tool is marked `readOnlyHint` in the tool list.

| Tool | What it answers | Share key | Operator key needs |
|---|---|---|---|
| `project_metrics_document` | Your project's programme metrics document: web and API figures for the last 30 days | yes, own project | `web:read` + `api:read` |
| `evidence_links` | SCF evidence links: one signed traction snapshot (by id or by its `/verify/…` link) with its status and daily-seal proof, or a project's full snapshot list | yes | any operator key |
| `list_projects` | Projects with verification level, SCF award linkage, sites and services | — | `registry:read` |
| `web_summary` | Page views, visitors, visits, bounce rate and duration per project. `variant=verified` (default) or `raw` | — | `web:read` |
| `api_routes_summary` | API requests by route, service or project: status classes, 5xx rate, latency percentiles | — | `api:read` |
| `trust_flags` | Advisory trust scores with reason codes, anti-inflation verdict counters, API assurance level | — | `web:read` (+ `api:read` for assurance) |
| `evidence_pack` | Everything about one project in one answer: record, verified and raw web, verdicts, API totals, top routes, trust | — | `registry:read` + `web:read` + `api:read` |

The assistant only sees the tools your key can use. A share key lists two tools. An operator key lists the tools its
scopes allow.

How to read the numbers:

- Date ranges are whole UTC days. `start` is included and `end` is excluded.
- **Verified** web figures leave out events that failed the anti-inflation checks.
- **API figures are self-attested telemetry.** The project sends them. UsageMap can check their shape and consistency
  but cannot prove they are genuine.
- **Trust scores are advisory**, not counts.
- A **seal** shows that a published snapshot has not been changed since. It does not prove the numbers are genuine.
- Small counts are hidden or rounded under the same privacy rules as everywhere else.

## Connect your client

Each example reads the key from an environment variable named `USAGEMAP_KEY`. Set it in your shell or your client's
secret store, for example `export USAGEMAP_KEY=scfa_pub_…`.

### Claude Code

```sh
claude mcp add --transport http usagemap https://app.usagemap.dev/mcp \
  --header "Authorization: Bearer $USAGEMAP_KEY"
```

Or check a project-scoped `.mcp.json` into your repository. It holds no secret, because Claude Code expands the variable
when it starts:

```json
{
  "mcpServers": {
    "usagemap": {
      "type": "http",
      "url": "https://app.usagemap.dev/mcp",
      "headers": { "Authorization": "Bearer ${USAGEMAP_KEY}" }
    }
  }
}
```

### Cursor

In `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "usagemap": {
      "url": "https://app.usagemap.dev/mcp",
      "headers": { "Authorization": "Bearer ${env:USAGEMAP_KEY}" }
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)

In `.vscode/mcp.json`. VS Code asks for the key once and stores it in its secret storage:

```json
{
  "inputs": [
    { "type": "promptString", "id": "usagemap-key", "description": "UsageMap API key", "password": true }
  ],
  "servers": {
    "usagemap": {
      "type": "http",
      "url": "https://app.usagemap.dev/mcp",
      "headers": { "Authorization": "Bearer ${input:usagemap-key}" }
    }
  }
}
```

### Claude Desktop, claude.ai and Claude Code with OAuth sign-in

The hosted server at `https://app.usagemap.dev/mcp` supports OAuth sign-in, so you do not need to paste an API key.

**claude.ai and Claude Desktop.** Settings → Connectors → Add custom connector → URL `https://app.usagemap.dev/mcp`.
Leave the client ID and secret empty: Claude registers itself. Click Connect; a UsageMap tab opens. Sign in as usual
(GitHub, Stellar wallet, passkey), then choose **which one project** Claude may read and click *Allow read-only
access*. You are sent back to Claude.

**Claude Code.** `claude mcp add --transport http usagemap https://app.usagemap.dev/mcp`, then `/mcp` → usagemap →
Authenticate. The consent page warns that the app receives access on *this computer*: that is expected for Claude
Code.

**What Claude can do with it.** Read the chosen project's website traffic (verified and raw), wallet funnel, API
usage (self-attested), Stellar surfaces, trust scores and signed traction snapshots — tools `project_overview`,
`web_stats`, `web_timeseries`, `web_breakdown`, `wallet_funnel`, `api_summary`, `api_stellar_surfaces`,
`trust_scores`, `traction_snapshots`. It cannot change anything and cannot see members, keys, tokens or the audit log.
One connection = one project; connect again to choose another.

**SCF operators** with two passkeys can instead choose *SCF operator view* (all projects, read-only: `list_projects`,
`web_summary`, `api_routes_summary`, `trust_flags`, `evidence_pack`, `evidence_links`). It asks for a passkey, ends
after 30 minutes without use and at most after 12 hours, and every read is audited like an operator key.

**Ending access.** Portal → Connected apps (`/oauth/apps`) → Disconnect: effective immediately. Access also ends when
you leave the project, when your account is disabled, or after 90 days.

**How it works (details in [Authorisation](#authorisation)).** OAuth 2.1 with PKCE (S256 only), protected resource metadata (RFC 9728),
authorization server metadata (RFC 8414) at `https://app.usagemap.dev/.well-known/oauth-authorization-server`,
client registration by Client ID Metadata Document or Dynamic Client Registration (public clients, rate-limited),
tokens bound to the MCP server (RFC 8707), refresh tokens rotated (reuse revokes the connection). The MCP server never
forwards your token: it exchanges it (RFC 8693) for a five-minute internal token, and the control plane checks your
access again on every call. Tokens are stored only as SHA-256 hashes; no IP address or browser data is stored.

API keys keep working: `Authorization: Bearer scfa_op_…` (operators) or `scfa_pub_…` (a project's share key).

**Without OAuth (local server).** Until OAuth is enabled on the host you use (it is off unless the operator sets the
exchange secret, and an older host answers the connector screen with an error), run the **local** server in Claude
Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "usagemap": {
      "command": "/path/to/usagemap/tools/mcp/run",
      "args": ["serve"],
      "env": {
        "USAGEMAP_API_URL": "https://app.usagemap.dev",
        "USAGEMAP_SHARE_KEY_FILE": "/absolute/path/to/share.key"
      }
    }
  }
}
```

For an operator key, use `USAGEMAP_OPERATOR_KEY_FILE` instead. Make the key file readable only by you
(`chmod 600`).

### Any other client: plain HTTP

Any client that speaks MCP Streamable HTTP and can send a header will work. This is a 2026-07-28 request, so it
carries the version, method and tool name both as headers and in the body:

```sh
curl -s https://app.usagemap.dev/mcp \
  -H "Authorization: Bearer $USAGEMAP_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: project_metrics_document' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"project_metrics_document","arguments":{"slug":"your-project"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

To list the tools, send `tools/list` the same way: put `Mcp-Method: tools/list` in the headers, leave out `Mcp-Name`,
and set `"method":"tools/list"` in the body. Clients on 2025-11-25 send `initialize` first, then
`MCP-Protocol-Version: 2025-11-25` on every later request.

## How the server behaves

- **One endpoint.** `POST /mcp` is the only method. `GET` and `DELETE` return `405`, because the server never pushes
  messages. Every answer is a single `application/json` body, never an event stream.
- **No sessions.** The server does not create an `Mcp-Session-Id` and ignores one if the client sends it. Every request
  stands alone.
- **Errors.** A missing or invalid key gets `401` with `WWW-Authenticate: Bearer`. A missing or mismatched MCP header
  gets `400` with JSON-RPC error `-32020`. An unsupported protocol version gets `400` with `-32022` and the list of
  supported versions. An unknown method gets `404`. Errors inside a tool, such as a bad date or a project the key
  cannot see, come back as a normal tool result with `isError: true`.
- **Limits.**
  - 120 requests per minute per key, then `429` with `Retry-After`.
  - 20 failed sign-ins per minute per network (`/24` for IPv4, `/48` for IPv6). After that the network is paused for
    the rest of the minute.
  - Bodies up to 1 MiB.
  - The API's own per-key limits also apply to every call.
- **Browsers.** A request with an `Origin` header from a site that is not allow-listed gets `403`. This protects
  against DNS-rebinding attacks. Desktop and command-line clients send no `Origin` and are not affected.
- **Cancellation.** If the client closes the connection, the server cancels the API calls of that request.

## Privacy, logging and audit

- The server keeps nothing. It has no database or cache of results. It holds an operator key's scopes in memory for up
  to 30 seconds, and the cache is keyed by a hash of the whole key.
- Its log has one line per request: method, tool name, key kind, the key's **public** id, status and duration. It never
  logs a key, request headers, IP addresses, query strings, tool arguments or results.
- To count failed sign-ins per network, it reduces an address to its subnet and then to a keyed hash. It stores
  neither the address nor the subnet.
- **Operator reads are audited by the API.** Each data read made with an operator key is recorded in the platform's
  audit log under that key's id, whether it came from the portal, a script or the MCP server. Share-key reads follow the
  same rules as reading the metrics document directly.

## Authorisation

The hosted server accepts two kinds of credentials:

1. **Your UsageMap key** as `Authorization: Bearer scfa_pub_…` or `scfa_op_…`: plain bearer-token authentication, for
   scripts and for clients that send a header.
2. **OAuth 2.1**, as the MCP authorisation specification (2026-07-28) describes, for the connector screens:
   - **Protected Resource Metadata** (RFC 9728) at `https://app.usagemap.dev/.well-known/oauth-protected-resource/mcp`
     names `https://app.usagemap.dev/mcp` as the resource and the portal origin as the authorisation server; a request
     without credentials gets `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="usagemap:read"`.
   - The **control plane is the authorisation server** (metadata at
     `https://app.usagemap.dev/.well-known/oauth-authorization-server`, RFC 8414): authorisation code with PKCE (S256
     only), `iss` in the response (RFC 9207), client registration by Client ID Metadata Document or Dynamic Client
     Registration (public clients only, rate-limited). You sign in with the portal's usual methods and choose on the
     consent screen **one project, read-only** — or, as an SCF operator with two passkeys and a fresh passkey check,
     the read-only operator view.
   - **Tokens are opaque, short-lived and bound** to `https://app.usagemap.dev/mcp` (RFC 8707): codes 60 seconds and
     single-use, access tokens 10 minutes, refresh tokens rotated on every use (a reused code or refresh token revokes
     the connection). A project connection lasts at most 90 days; an operator connection at most 12 hours and ends
     after 30 minutes without use. Only SHA-256 hashes are stored; no IP address or browser data.
   - The MCP server **never passes a client's token on**. It exchanges it (RFC 8693) for a five-minute internal token
     that the control plane accepts only on the project's read operations (or, for operators, the read-only operator
     API), and the control plane checks your access again on every call: membership, project state, operator role and
     passkeys, account.
   - **Revocation:** Portal → Connected apps (`/oauth/apps`), effective immediately; also RFC 7009 token revocation.

Why opaque tokens with exchange and not self-validated JWTs: revocation takes effect at once, there is no signing key to
rotate, and the specification forbids token passthrough. Design record: register C-168.

## Self-hosting

The hosted server is `services/mcp`. It runs on Node.js 24 and uses only the standard library. The image is
`services/mcp/Dockerfile`: pinned base, non-root user, read-only file system, no secrets mounted. Settings are
environment variables: `MCP_CONTROL_PLANE_URL`, `MCP_PATH`, `MCP_ALLOWED_ORIGINS`, `MCP_TRUST_PROXY`,
`MCP_FORWARD_CLIENT_ADDRESS`, `MCP_KEY_RATE_PER_MIN`, `MCP_AUTH_FAIL_PER_MIN`, `MCP_MAX_INFLIGHT` and
`MCP_INTROSPECT_CACHE_MS` (see `services/mcp/src/config.ts`). It shares its tools with the local server in
`tools/mcp`: one tool list, two transports.
