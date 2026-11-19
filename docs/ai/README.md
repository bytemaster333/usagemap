# UsageMap for AI assistants

Three ways for an AI coding assistant or agent to work with UsageMap: a **skill** that instruments a project, two
**plain-text indexes** of the documentation, and an **MCP endpoint** that answers questions about a project's
numbers. None of them needs anything installed on the site being measured.

| What | URL | For |
|---|---|---|
| Agent skill | <https://usagemap.dev/skill.md> | an assistant that adds UsageMap to a Stellar web app, dApp or API |
| Docs index | <https://usagemap.dev/llms.txt> | a model that needs to know which page answers what |
| All docs in one file | <https://usagemap.dev/llms-full.txt> | a model that should read everything at once |
| MCP endpoint | `https://app.usagemap.dev/mcp` | an assistant that reads a project's or the programme's aggregates |

## The skill: `skill.md`

`skill.md` is an [Agent Skills](https://agentskills.io/specification) file: YAML frontmatter with a `name`
(`usagemap-instrument`) and a `description` that says when to use it, then step-by-step instructions. Assistants that
support skills load the description first and the instructions only when a task matches.

What it makes the assistant do, in order:

1. find the project's web framework, wallet library, API servers and contracts;
2. ask you to sign in to the portal with your Stellar wallet, create the project, and hand over the **site key**
   (public) and an **ingest token** (secret; it goes into your secret store, never into code or a commit);
3. add the tracker script tag with its version and `integrity` hash, and check the hash against the served file;
4. attach the Stellar Wallets Kit or wallet adapters for wallet events;
5. configure OpenTelemetry for each API server with environment variables;
6. ask you to register the project's contracts (the footprint), with the contract IDs it found;
7. test: a local page view seen in the portal's first-event panel, and one OTLP data point sent with `curl`
   (`{"partialSuccess":{}} 200`) seen in the API dashboard;
8. tell you what it changed and which portal steps are left (domain verification, footprint, sharing with SCF).

The steps that need your wallet are always yours: the skill never asks for a secret key or a recovery phrase.

**Install it.**

- Claude Code and other clients that read skills from a folder: save the file as
  `.claude/skills/usagemap-instrument/SKILL.md` in the project (or the client's equivalent skills folder); the
  folder name must match the skill's `name`.

  ```sh
  mkdir -p .claude/skills/usagemap-instrument
  curl -s https://usagemap.dev/skill.md -o .claude/skills/usagemap-instrument/SKILL.md
  ```

- Any other assistant: give it the URL and ask it to follow the file ("Follow https://usagemap.dev/skill.md to add
  UsageMap to this project").

The same file is also served at <https://usagemap.dev/skills/usagemap-instrument/SKILL.md>, the path layout skill
catalogues use.

## The documentation indexes: `llms.txt` and `llms-full.txt`

- [`/llms.txt`](https://usagemap.dev/llms.txt) follows the [llms.txt convention](https://llmstxt.org/): a title, a
  one-paragraph summary, then one line per page grouped as on the [documentation index](/docs/).
- [`/llms-full.txt`](https://usagemap.dev/llms-full.txt) is every published document in one plain-text file, each
  starting with its URL and its source file's hash, in the order of `llms.txt`.

Both are generated at build time from the same files as the HTML pages, so they never disagree with the site.

## The MCP endpoint

`https://app.usagemap.dev/mcp` is a read-only Model Context Protocol server (Streamable HTTP) over the same
aggregates as the portal and the operator API. It has no key of its own: every call runs with your share key
(`scfa_pub_…`, your own project) or operator key (`scfa_op_…`), and the API decides what that key may read.

**Status:** served on usagemap.dev, with a share key or an operator key. OAuth sign-in for the claude.ai / Claude Desktop / Claude Code connectors is built and switched on for
usagemap.dev in a later step; until then use a key, or the local server. Tools, client configuration (Claude Code,
Cursor, VS Code, Claude Desktop) and limits: [MCP server](mcp.md).

## What an assistant never gets

The same privacy rules apply to every interface: no IP addresses, User-Agent strings, query strings, page titles,
visitor identifiers or end-user wallet addresses exist in UsageMap to be returned — see the
[data inventory](/docs/privacy/data-inventory/).
