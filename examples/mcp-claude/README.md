# AI assistants (MCP server): Claude Code, Claude Desktop, Cursor

UsageMap's MCP server is a local, read-only Model Context Protocol server (stdio, Node standard library only). Your
assistant answers questions such as "how many visits and wallet connects did we have last week, and which API routes
fail most?" from the same aggregates the portal shows; there are no raw events it could return. It reads a **share
key** of your project from a file and never prints it. This folder has the configuration for three clients. Guide:
[Getting started](../../docs/onboarding/README.md) (portal card "AI assistants (MCP server)") and
[sharing](../../docs/onboarding/share-with-scf.md).

## Run it

1. **Install:** clone this repository (the server is `tools/mcp/server.ts`; nothing to install, Node 24 runs it).
2. **Set your key:** portal **Sharing** → create a share key (`scfa_pub_…`), save it alone in a file (`chmod 600`),
   and put that file's path and the repository's path into the configuration of your client below.
3. **Run:** restart the client (Claude Code: copy `mcp.json` to `.mcp.json` in your project root, run `claude`, then `/mcp` lists `usagemap`
   with 7 tools); ask "Use usagemap: summarise this month's web and API usage of <your project slug>".

## The lines that add UsageMap

`mcp.json`:

```json
{
  "mcpServers": {
    "usagemap": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/usagemap/tools/mcp/server.ts"],
      "env": {
        "USAGEMAP_API_URL": "https://app.usagemap.dev",
        "USAGEMAP_SHARE_KEY_FILE": "/path/to/usagemap-share.key"
      }
    }
  }
}
```

That is Claude Code's project file (repository root). `claude_desktop_config.json` (Claude Desktop: **Settings →
Developer → Edit Config**) and `cursor-mcp.json` (Cursor: `.cursor/mcp.json` or `~/.cursor/mcp.json`) hold the same
`usagemap` entry without `"type"`. Or register it for every Claude Code project from the shell:

`claude-code.sh`:

```sh
claude mcp add usagemap --scope user \
  -e USAGEMAP_API_URL=https://app.usagemap.dev \
  -e USAGEMAP_SHARE_KEY_FILE=/path/to/usagemap-share.key \
  -- node /path/to/usagemap/tools/mcp/server.ts
```

SCF operators use `USAGEMAP_OPERATOR_KEY_FILE` (an `scfa_op_…` key) instead, which adds `list_projects`,
`trust_flags` and the evidence pack for every project.

## What you'll see in the portal

Nothing new: the server only reads aggregates you can already see (the project's metrics document, API routes, trust
flags, evidence links) through the share key. Revoking the key on **Sharing** cuts the assistant off. The
Integrations page lists this card as "Runs locally".

## Test it without the app

```sh
tools/mcp/run selftest   # protocol and tool tests against a mock API, no network
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl-test","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | USAGEMAP_SHARE_KEY_FILE=/path/to/usagemap-share.key node tools/mcp/server.ts   # → the 7 tools
```

## Tested by

`tests/quickstarts/integrations/tools.spec.ts` (`mcp-claude`): parses the three JSON files and `claude-code.sh`,
checks that each starts `node …/tools/mcp/server.ts` (which exists) with only the variables the server reads
(`USAGEMAP_API_URL`, `USAGEMAP_SHARE_KEY_FILE`), then starts the server with that exact configuration (paths pointed
at this checkout, a test share key, the API at a local stand-in), runs the MCP `initialize` → `tools/list` →
`tools/call project_metrics_document` exchange over stdio, and checks the 7 tools, one GET of
`/public/v1/projects/<slug>/metrics.json` with the share key, and that the key is never printed. It also runs
`tools/mcp/run selftest`. **Not run:** the assistants themselves (Claude Code, Claude Desktop, Cursor need accounts
and a desktop session).
