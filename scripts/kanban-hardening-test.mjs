const baseUrl = process.env.KANBAN_BASE_URL || "http://127.0.0.1:8080";
const apiKey = process.env.KANBAN_API_KEY;

if (!apiKey) throw new Error("KANBAN_API_KEY is required");

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.auth === false ? {} : { Authorization: `Bearer ${apiKey}` }),
      ...(options.headers || {}),
    },
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const health = await request("/health", { auth: false });
assert(health.status === 200, "/health must be public and healthy");
assert(health.headers.get("x-content-type-options") === "nosniff", "security header x-content-type-options missing");

const ready = await request("/ready", { auth: false });
assert(ready.status === 200, "/ready must check dependencies");
const readyPayload = await ready.json();
assert(readyPayload.db === "ok", "/ready must report db ok");

const unauthorized = await request("/api/v1/boards?account_id=1", { auth: false });
assert(unauthorized.status === 401, "API without key must be rejected");

const invalidJson = await request("/api/v1/cards/upsert", {
  method: "POST",
  body: "{",
});
assert(invalidJson.status === 400, "invalid JSON must be rejected");

const wrongType = await request("/api/v1/cards/upsert", {
  method: "POST",
  body: JSON.stringify({}),
  headers: { "Content-Type": "text/plain" },
});
assert(wrongType.status === 415, "wrong content-type must be rejected");

const tooLarge = await request("/api/v1/cards/upsert", {
  method: "POST",
  body: JSON.stringify({ payload: "x".repeat(280000) }),
});
assert(tooLarge.status === 413, "large JSON body must be rejected");

console.log(JSON.stringify({ ok: true, checks: ["health", "ready", "auth", "invalid-json", "content-type", "payload-limit"] }));
