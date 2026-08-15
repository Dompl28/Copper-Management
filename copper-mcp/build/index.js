#!/usr/bin/env node
/**
 * Copper Rental CRM MCP Server
 * ----------------------------
 * Tools that back the TorsX rental-inquiry -> Copper People workflow.
 *
 * Design principles baked into the tool descriptions so the calling agent
 * behaves safely:
 *   - Always inspect schema before writing (field IDs can change).
 *   - Always search before creating a Person (dedupe by email, then phone, then name).
 *   - Never overwrite conflicting data; only fill blanks or explicit replacements.
 *   - Never fabricate activities to move Copper's Last Contacted date.
 *   - Never create custom fields, delete, or merge.
 *
 * Credentials come only from environment secrets (COPPER_API_KEY, COPPER_USER_EMAIL).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { copper, CopperAuthError, CopperApiError, isConfigured } from "./copper.js";
const server = new McpServer({
    name: "copper-rental-crm",
    version: "1.0.0",
});
// ---- shared response helpers --------------------------------------------
function ok(data) {
    return {
        content: [
            { type: "text", text: JSON.stringify(data, null, 2) },
        ],
        structuredContent: data && typeof data === "object" && !Array.isArray(data)
            ? data
            : { result: data },
    };
}
function fail(message) {
    return {
        content: [{ type: "text", text: message }],
        isError: true,
    };
}
async function run(fn) {
    try {
        return ok(await fn());
    }
    catch (err) {
        if (err instanceof CopperAuthError)
            return fail(err.message);
        if (err instanceof CopperApiError)
            return fail(err.message);
        return fail(`Unexpected error: ${err.message}`);
    }
}
// ---- Tool 1: inspect schema (Phase 1) -----------------------------------
server.registerTool("copper_inspect_schema", {
    title: "Inspect Copper configuration",
    description: "Retrieve the live Copper configuration BEFORE any write. Returns People custom-field " +
        "definitions (name -> id -> data type -> valid dropdown/multi-select options), contact " +
        "types, activity types, and users (so you can resolve the owner/assignee id for Dominique " +
        "Pierre-Louis). Field IDs differ from labels and can change — always map Field Name -> Field " +
        "ID -> Data Type -> Valid Values from THIS call rather than trusting remembered IDs. " +
        "Read-only.",
    inputSchema: {
        include: z
            .array(z.enum(["custom_fields", "contact_types", "activity_types", "users", "account"]))
            .optional()
            .describe("Which config sections to return. Omit for all. Narrow this to reduce payload size on repeat calls."),
    },
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
}, async ({ include }) => {
    const want = (s) => !include || include.includes(s);
    return run(async () => {
        const out = {};
        if (want("custom_fields"))
            out.custom_field_definitions = await copper.listCustomFieldDefinitions();
        if (want("contact_types"))
            out.contact_types = await copper.listContactTypes();
        if (want("activity_types"))
            out.activity_types = await copper.listActivityTypes();
        if (want("users"))
            out.users = await copper.searchUsers();
        if (want("account"))
            out.account = await copper.getAccount();
        out._guidance =
            "Build an internal map Field Name -> Field ID -> Data Type -> Valid Values from " +
                "custom_field_definitions. Resolve Dominique's user id from users for the owner/assignee. " +
                "Note types: a Copper Note is created via copper_create_note (activity type category 'user', id 0).";
        return out;
    });
});
// ---- Tool 2: search people (Phase 5 dedupe) -----------------------------
server.registerTool("copper_search_people", {
    title: "Search Copper People (dedupe)",
    description: "Search existing People BEFORE creating anyone. Dedupe order per workflow: (1) exact email, " +
        "(2) normalized phone, (3) name + context. Provide the strongest identifier you have. " +
        "Matching criteria are combined with AND, so search ONE identifier at a time (e.g. just the " +
        "email) to avoid false negatives. Returns matching person records including id, emails, " +
        "phone_numbers, date_last_contacted, interaction_count, tags, and custom_fields. Read-only — " +
        "one person should map to one Copper record; do not create a duplicate just because they used " +
        "a new platform, thread, or slightly different name.",
    inputSchema: {
        emails: z
            .array(z.string())
            .optional()
            .describe("Prospect email address(es) — the PRIMARY identity check. Use the prospect's real email, not a StreetEasy/Zillow/RentHop relay address."),
        phone_number: z.string().optional().describe("Single phone number (secondary check when email is unavailable/uncertain)."),
        name: z.string().optional().describe("Full name (tertiary check; combine with a manual review of results)."),
        page_size: z.number().int().min(1).max(200).optional().describe("Max results (default 20)."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ emails, phone_number, name, page_size }) => {
    if (!emails && !phone_number && !name) {
        return fail("Provide at least one of: emails, phone_number, name.");
    }
    const body = {};
    if (emails)
        body.emails = emails;
    if (phone_number)
        body.phone_number = phone_number;
    if (name)
        body.name = name;
    if (page_size)
        body.page_size = page_size;
    return run(() => copper.searchPeople(body));
});
// ---- Tool 3: get person -------------------------------------------------
server.registerTool("copper_get_person", {
    title: "Get a Copper Person",
    description: "Fetch a single Person by id, including all custom fields, tags, address, contact_type_id, " +
        "assignee_id, date_last_contacted, and interaction_count. Use this to read the current record " +
        "before deciding which blank fields to fill (never overwrite conflicting non-blank data). Read-only.",
    inputSchema: { id: z.number().int().describe("Copper Person id.") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ id }) => run(() => copper.getPerson(id)));
// ---- Tool 4: create person (Phase 7) ------------------------------------
server.registerTool("copper_create_person", {
    title: "Create a Copper Person",
    description: "Create ONE new Person — only after copper_search_people confirms no match exists. Populate " +
        "only fields supported by verified email/thread/listing/calendar evidence; leave everything " +
        "else blank rather than inventing values. Pass custom fields as custom_fields: an array of " +
        "{ custom_field_definition_id, value } using CURRENT ids from copper_inspect_schema. Set " +
        "assignee_id to Dominique's user id, and add lead-source tags (e.g. 'StreetEasy'). The Person " +
        "address is the PROSPECT's own address — never the rental listing. Do not create Deals or " +
        "custom fields here.",
    inputSchema: {
        name: z.string().describe("Prospect's confirmed full name. Do not invent a surname."),
        emails: z
            .array(z.object({ email: z.string(), category: z.string().default("work") }))
            .optional()
            .describe("e.g. [{ email: 'jane@x.com', category: 'work' }] — the prospect's real email."),
        phone_numbers: z
            .array(z.object({ number: z.string(), category: z.string().default("mobile") }))
            .optional()
            .describe("Only when a number belonging to the prospect is explicitly provided."),
        contact_type_id: z.number().int().optional().describe("Current renter/prospect contact type id from schema. Do not default to a Voucher type."),
        assignee_id: z.number().int().optional().describe("Dominique Pierre-Louis's Copper user id (resolve via copper_inspect_schema)."),
        tags: z.array(z.string()).optional().describe("Lead-origin tags, e.g. ['StreetEasy'] or ['Zillow']. Keep minimal."),
        address: z
            .object({
            street: z.string().optional(),
            city: z.string().optional(),
            state: z.string().optional(),
            postal_code: z.string().optional(),
            country: z.string().optional(),
        })
            .optional()
            .describe("The PROSPECT's mailing address only. Leave blank if unknown. Never put the rental listing address here."),
        details: z.string().optional().describe("Concise search snapshot for the Description/details field (not an email archive)."),
        custom_fields: z
            .array(z.object({ custom_field_definition_id: z.number().int(), value: z.any() }))
            .optional()
            .describe("Array of { custom_field_definition_id, value } using current ids from copper_inspect_schema."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (args) => {
    const body = { name: args.name };
    if (args.emails)
        body.emails = args.emails;
    if (args.phone_numbers)
        body.phone_numbers = args.phone_numbers;
    if (args.contact_type_id !== undefined)
        body.contact_type_id = args.contact_type_id;
    if (args.assignee_id !== undefined)
        body.assignee_id = args.assignee_id;
    if (args.tags)
        body.tags = args.tags;
    if (args.address)
        body.address = args.address;
    if (args.details)
        body.details = args.details;
    if (args.custom_fields)
        body.custom_fields = args.custom_fields;
    return run(() => copper.createPerson(body));
});
// ---- Tool 5: update person (Phase 6) ------------------------------------
server.registerTool("copper_update_person", {
    title: "Update a Copper Person",
    description: "Update an EXISTING Person. Use to fill blank fields when new, explicit information appears, or " +
        "to apply an explicit replacement (e.g. budget raised). Do NOT overwrite non-blank data that " +
        "conflicts without clear evidence — in that case leave it and flag CONFLICTING CRM DATA for " +
        "human review instead. Only send the fields you intend to change. custom_fields entries use " +
        "current ids from copper_inspect_schema. Never fabricate a Deposit Submitted / guarantor / " +
        "shown-listing value; those require explicit confirmation.",
    inputSchema: {
        id: z.number().int().describe("Copper Person id to update."),
        name: z.string().optional(),
        emails: z.array(z.object({ email: z.string(), category: z.string().default("work") })).optional(),
        phone_numbers: z.array(z.object({ number: z.string(), category: z.string().default("mobile") })).optional(),
        contact_type_id: z.number().int().optional(),
        assignee_id: z.number().int().optional(),
        tags: z.array(z.string()).optional().describe("Copper replaces the full tag set — include existing tags you want to keep."),
        address: z
            .object({
            street: z.string().optional(),
            city: z.string().optional(),
            state: z.string().optional(),
            postal_code: z.string().optional(),
            country: z.string().optional(),
        })
            .optional(),
        details: z.string().optional(),
        custom_fields: z.array(z.object({ custom_field_definition_id: z.number().int(), value: z.any() })).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async (args) => {
    const { id, ...rest } = args;
    const body = {};
    for (const [k, v] of Object.entries(rest))
        if (v !== undefined)
            body[k] = v;
    if (Object.keys(body).length === 0)
        return fail("No fields provided to update.");
    return run(() => copper.updatePerson(id, body));
});
// ---- Tool 6: list a person's activities (Phase 9 note dedupe) -----------
server.registerTool("copper_list_person_activities", {
    title: "List a Person's activities",
    description: "List activities (notes, emails, meetings, etc.) on a Person BEFORE writing a new note, so you " +
        "don't duplicate history already captured. Also useful to read Copper's own last-contacted " +
        "signal. Note: Copper's date_last_contacted / interaction_count on the Person record (from " +
        "copper_get_person) is the CRM's native contact signal — compare it against the Gmail-derived " +
        "last outbound timestamp; if Gmail is newer, report COPPER LAST CONTACTED MISMATCH rather than " +
        "fabricating an interaction. Read-only.",
    inputSchema: {
        person_id: z.number().int().describe("Copper Person id."),
        page_size: z.number().int().min(1).max(200).optional().describe("Max activities (default 20)."),
        full_result: z.boolean().optional().describe("If true, include system activities too; default focuses on user notes/logged activity."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ person_id, page_size, full_result }) => {
    const body = {
        parent: { type: "person", id: person_id },
    };
    if (page_size)
        body.page_size = page_size;
    if (full_result)
        body.full_result = true;
    return run(() => copper.searchActivities(body));
});
// ---- Tool 7: create a note (Phase 9) ------------------------------------
server.registerTool("copper_create_note", {
    title: "Create a Copper Note on a Person",
    description: "Add a structured Note activity to a Person. Use for 'Lead Intake — [Source] — [Listing]' on " +
        "new People and 'Conversation Update — YYYY-MM-DD' on material new interactions. Summarize the " +
        "conversation; do not paste entire email threads or any sensitive data (SSNs, bank/account " +
        "numbers, IDs, application attachments, door codes). Before calling, check " +
        "copper_list_person_activities so you don't recreate an already-captured note. This creates a " +
        "Note only — it does NOT and must NOT be used to fake a call/meeting to change Last Contacted.",
    inputSchema: {
        person_id: z.number().int().describe("Copper Person id to attach the note to."),
        details: z.string().describe("The note body (structured summary). Timestamps should be in America/New_York, e.g. 'August 14, 2026 at 11:42 AM ET'."),
        activity_type_id: z
            .number()
            .int()
            .optional()
            .describe("Override the note activity type id if your account differs. Default is the standard Copper Note type (category 'user', id 0)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ person_id, details, activity_type_id }) => {
    const body = {
        parent: { type: "person", id: person_id },
        type: { category: "user", id: activity_type_id ?? 0 },
        details,
    };
    return run(() => copper.createActivity(body));
});
// ---- transport bootstrap ------------------------------------------------
async function main() {
    if (!isConfigured()) {
        // Surface the problem loudly on startup, but still start so the client can
        // connect and receive the actionable error on first tool call.
        process.stderr.write("[copper-rental-crm] WARNING: COPPER_API_KEY is not set. Tools will return " +
            "'COPPER AUTHENTICATION NOT CONFIGURED' until the secret is provided.\n");
    }
    const transport = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
    if (transport === "http") {
        // Remote hosting mode (for a claude.ai custom connector behind your own HTTPS).
        const express = (await import("express")).default;
        const { createHash, randomUUID } = await import("crypto");
        const app = express();
        app.set("trust proxy", true);
        app.use(express.json());
        app.use(express.urlencoded({ extended: false }));
        // ---- OAuth 2.0 (required by claude.ai custom connector) ----
        // In-memory store — sufficient for a single-tenant personal server.
        const oauthClients = new Map();
        const oauthCodes = new Map();
        const oauthTokens = new Set();
        const baseUrl = (req) => `https://${req.hostname}`;
        // RFC 9728 – Protected Resource Metadata
        app.get("/.well-known/oauth-protected-resource", (req, res) => {
            const b = baseUrl(req);
            res.json({ resource: b, authorization_servers: [b] });
        });
        // RFC 8414 – Authorization Server Metadata
        app.get("/.well-known/oauth-authorization-server", (req, res) => {
            const b = baseUrl(req);
            res.json({
                issuer: b,
                authorization_endpoint: `${b}/oauth/authorize`,
                token_endpoint: `${b}/oauth/token`,
                registration_endpoint: `${b}/oauth/register`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
            });
        });
        // RFC 7591 – Dynamic Client Registration
        app.post("/oauth/register", (req, res) => {
            const clientId = randomUUID().replace(/-/g, "");
            oauthClients.set(clientId, req.body);
            res.status(201).json({
                client_id: clientId,
                redirect_uris: req.body.redirect_uris || [],
                client_name: req.body.client_name || "MCP Client",
                grant_types: ["authorization_code"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
            });
        });
        // Authorization Endpoint – auto-approve (single-tenant personal server)
        app.get("/oauth/authorize", (req, res) => {
            const { redirect_uri, state, code_challenge, code_challenge_method } = req.query;
            const code = randomUUID().replace(/-/g, "");
            oauthCodes.set(code, { redirect_uri, code_challenge, code_challenge_method });
            const redir = new URL(redirect_uri);
            redir.searchParams.set("code", code);
            if (state) redir.searchParams.set("state", state);
            res.redirect(redir.toString());
        });
        // Token Endpoint
        app.post("/oauth/token", (req, res) => {
            const { grant_type, code, code_verifier } = req.body;
            if (grant_type === "authorization_code") {
                const codeData = oauthCodes.get(code);
                if (!codeData) return res.status(400).json({ error: "invalid_grant" });
                oauthCodes.delete(code);
                if (codeData.code_challenge && codeData.code_challenge_method === "S256") {
                    const expected = createHash("sha256").update(code_verifier || "").digest("base64url");
                    if (expected !== codeData.code_challenge) {
                        return res.status(400).json({ error: "invalid_grant", error_description: "PKCE mismatch" });
                    }
                }
                const token = randomUUID().replace(/-/g, "");
                oauthTokens.add(token);
                return res.json({ access_token: token, token_type: "bearer", expires_in: 2592000 });
            }
            if (grant_type === "refresh_token") {
                const token = randomUUID().replace(/-/g, "");
                oauthTokens.add(token);
                return res.json({ access_token: token, token_type: "bearer", expires_in: 2592000 });
            }
            res.status(400).json({ error: "unsupported_grant_type" });
        });
        // ---- MCP endpoint ----
        const httpTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless JSON mode
        });
        await server.connect(httpTransport);
        app.post("/mcp", (req, res) => {
            httpTransport.handleRequest(req, res, req.body);
        });
        app.get("/healthz", (_req, res) => res.status(200).send("ok"));
        const port = parseInt(process.env.PORT || "8787", 10);
        app.listen(port, () => {
            process.stderr.write(`[copper-rental-crm] HTTP transport listening on :${port}/mcp\n`);
        });
    }
    else {
        const stdio = new StdioServerTransport();
        await server.connect(stdio);
        process.stderr.write("[copper-rental-crm] stdio transport ready.\n");
    }
}
main().catch((err) => {
    process.stderr.write(`[copper-rental-crm] fatal: ${err.message}\n`);
    process.exit(1);
});
