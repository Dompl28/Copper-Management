# Copper Rental CRM — MCP Server

A Model Context Protocol server that lets Claude read and write your **Copper CRM**
so it can run the TorsX rental-inquiry → Copper People workflow: inspect your live
schema, dedupe, create/update People, and write structured Notes — with the safety
guardrails from your workflow baked into every tool.

Your Copper API key is **only ever read from an environment secret** (`COPPER_API_KEY`).
It is never hard-coded, logged, or passed through chat.

---

## What it gives Claude (7 tools)

| Tool | Purpose | Writes? |
|------|---------|---------|
| `copper_inspect_schema` | Pull live custom-field definitions + IDs + data types + dropdown options, contact types, activity types, and users (to resolve your owner ID). Run before any write. | No |
| `copper_search_people` | Dedupe by email → phone → name before creating anyone. | No |
| `copper_get_person` | Read one Person's full record incl. `date_last_contacted` / `interaction_count`. | No |
| `copper_create_person` | Create one Person (only after search finds no match). | Yes |
| `copper_update_person` | Fill blank/explicitly-replaced fields; never clobbers conflicting data. | Yes |
| `copper_list_person_activities` | Read existing notes so history isn't duplicated. | No |
| `copper_create_note` | Add `Lead Intake …` / `Conversation Update …` notes. | Yes |

The tools deliberately **cannot** delete People, merge records, create custom fields,
create Deals, or fabricate activities to change your Last Contacted date.

---

## Step 1 — Get a Copper API key

In Copper: **Settings → Integrations → API Keys → Generate API Key.**
Copy the key and note the email of the user who generated it (yours:
`dominique@torsx.com`). Treat the key like a password.

## Step 2 — Install & build

Requires Node.js 18+.

```bash
cd copper-mcp
npm install
npm run build
```

## Step 3 — Provide the secret

Copy `.env.example` to `.env` and fill it in (the `.env` file is git-ignored):

```
COPPER_API_KEY=paste_your_key_here
COPPER_USER_EMAIL=dominique@torsx.com
```

Or export the variables in your shell / hosting platform's secret manager instead of
using a file. Never commit the key.

## Step 4 — Connect it to Claude

There are two ways to run it. Pick the one that matches how you use Claude.

### Option A — Local, with Claude Desktop (simplest)

Runs on your own computer over stdio. Add this to your Claude Desktop config
(**Settings → Developer → Edit Config**, or the `claude_desktop_config.json` file):

```json
{
  "mcpServers": {
    "copper-rental-crm": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/copper-mcp/build/index.js"],
      "env": {
        "COPPER_API_KEY": "paste_your_key_here",
        "COPPER_USER_EMAIL": "dominique@torsx.com"
      }
    }
  }
}
```

Restart Claude Desktop. "copper-rental-crm" should appear with its 7 tools.

### Option B — Remote, as a claude.ai custom connector

Custom connectors on **claude.ai** need a public **HTTPS** URL. Host the server in
HTTP mode and point a connector at it.

Run in HTTP mode (behind your own HTTPS / reverse proxy, or a host like Render,
Railway, Fly.io, or a small VPS):

```bash
MCP_TRANSPORT=http PORT=8787 node build/index.js
# exposes POST https://your-domain/mcp  and  GET /healthz
```

Then in claude.ai: **Settings → Connectors → Add custom connector**, and enter your
server's `/mcp` URL. Set `COPPER_API_KEY` and `COPPER_USER_EMAIL` as secrets in your
hosting platform, not in the URL.

> Security note: the HTTP mode as shipped has no built-in authentication — anyone who
> can reach the URL can call the tools with your Copper key. Put it behind an
> authenticating reverse proxy, network allowlist, or add an auth layer before exposing
> it publicly. Option A (local) avoids this entirely.

## Step 5 — Verify

Ask Claude: *"Inspect my Copper schema."* If the key is good, you'll get your custom
fields, contact types, and users back. If not, you'll get a clear
`COPPER AUTHENTICATION NOT CONFIGURED` or credential-rejected message telling you what
to fix.

---

## How Claude should use it (workflow contract)

1. `copper_inspect_schema` first — never trust remembered field IDs.
2. `copper_search_people` (email → phone → name) before creating anyone.
3. Existing match → `copper_get_person`, then `copper_update_person` for blanks only.
4. No match → `copper_create_person` with only verified fields; tag the lead source.
5. `copper_list_person_activities` → `copper_create_note` (skip if already captured).
6. Compare Gmail's real last-outbound time against the Person's `date_last_contacted`;
   if Gmail is newer, report **COPPER LAST CONTACTED MISMATCH** — don't fake an activity.

---

## Copper API reference

Base URL `https://api.copper.com/developer_api/v1`. Auth headers: `X-PW-AccessToken`,
`X-PW-Application: developer_api`, `X-PW-UserEmail`, `Content-Type: application/json`.
See https://developer.copper.com/introduction/authentication.html
