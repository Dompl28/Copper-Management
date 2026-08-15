/**
 * Copper CRM API client.
 *
 * Auth is read from environment secrets — never hard-coded, never logged.
 *   COPPER_API_KEY     -> X-PW-AccessToken
 *   COPPER_USER_EMAIL  -> X-PW-UserEmail (defaults to dominique@torsx.com)
 *
 * Base URL and headers per Copper Developer API:
 *   https://developer.copper.com/introduction/authentication.html
 */
const BASE_URL = "https://api.copper.com/developer_api/v1";
export class CopperAuthError extends Error {
}
export class CopperApiError extends Error {
    status;
    body;
    constructor(status, message, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}
function getCredentials() {
    const token = process.env.COPPER_API_KEY;
    const email = process.env.COPPER_USER_EMAIL || "dominique@torsx.com";
    if (!token || token.trim() === "" || token === "your_copper_api_key_here") {
        throw new CopperAuthError("COPPER AUTHENTICATION NOT CONFIGURED — the COPPER_API_KEY secret is missing. " +
            "Set it in the server environment (never paste it into chat), then retry.");
    }
    return { token, email };
}
/** True when the API key secret is present. Used to fail fast with a clear message. */
export function isConfigured() {
    const token = process.env.COPPER_API_KEY;
    return !!token && token.trim() !== "" && token !== "your_copper_api_key_here";
}
async function request(method, path, body) {
    const { token, email } = getCredentials();
    const headers = {
        "X-PW-AccessToken": token,
        "X-PW-Application": "developer_api",
        "X-PW-UserEmail": email,
        "Content-Type": "application/json",
    };
    let res;
    try {
        res = await fetch(`${BASE_URL}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }
    catch (err) {
        throw new CopperApiError(0, `Network error reaching Copper (${method} ${path}): ${err.message}. ` +
            `Check connectivity and that the server can reach api.copper.com.`, null);
    }
    const text = await res.text();
    let parsed = null;
    if (text) {
        try {
            parsed = JSON.parse(text);
        }
        catch {
            parsed = text;
        }
    }
    if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
            throw new CopperAuthError(`Copper rejected the credentials (HTTP ${res.status}). Verify COPPER_API_KEY and ` +
                `COPPER_USER_EMAIL match the user who generated the key.`);
        }
        if (res.status === 422) {
            throw new CopperApiError(422, `Copper rejected the request as invalid (HTTP 422). This usually means a field ID, ` +
                `dropdown option, or contact-type ID does not exist. Re-run copper_inspect_schema and ` +
                `use only current IDs. Details: ${JSON.stringify(parsed)}`, parsed);
        }
        if (res.status === 429) {
            throw new CopperApiError(429, `Copper rate limit hit (HTTP 429). Wait a moment and retry with smaller batches.`, parsed);
        }
        throw new CopperApiError(res.status, `Copper API error (HTTP ${res.status}) on ${method} ${path}: ${JSON.stringify(parsed)}`, parsed);
    }
    return parsed;
}
export const copper = {
    // --- Schema / configuration introspection ---
    listCustomFieldDefinitions: () => request("GET", "/custom_field_definitions"),
    listContactTypes: () => request("GET", "/contact_types"),
    listActivityTypes: () => request("GET", "/activity_types"),
    getAccount: () => request("GET", "/account"),
    searchUsers: (page_size = 200) => request("POST", "/users/search", { page_size }),
    // --- People ---
    searchPeople: (body) => request("POST", "/people/search", body),
    getPerson: (id) => request("GET", `/people/${id}`),
    createPerson: (body) => request("POST", "/people", body),
    updatePerson: (id, body) => request("PUT", `/people/${id}`, body),
    // --- Activities (notes live here) ---
    searchActivities: (body) => request("POST", "/activities/search", body),
    createActivity: (body) => request("POST", "/activities", body),
};
