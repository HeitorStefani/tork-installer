const baseUrl = process.env.KANBAN_BASE_URL || "http://127.0.0.1:8080/api/v1";
const apiKey = process.env.KANBAN_API_KEY;

if (!apiKey) throw new Error("KANBAN_API_KEY is required");

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(`${path}: ${payload.error || response.status}`);
  return payload.data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const runId = `load-${Date.now()}`;
const createdIds = [];

try {
  for (let index = 0; index < 65; index += 1) {
    const card = await api("/cards/upsert", {
      method: "POST",
      body: JSON.stringify({
        account_id: 1,
        conversation_id: Number(`8${Date.now().toString().slice(-9)}${String(index).padStart(2, "0")}`),
        stage_key: "qualificado",
        contact_name: `Load Test ${index}`,
        service: "Teste de carga",
        observation: `Teste de paginacao ${runId}`,
        metadata: { loadTest: runId },
      }),
    });
    createdIds.push(card.id);
  }

  const first = await api("/cards?account_id=1&stage_key=qualificado&limit=30");
  assert(first.cards.length <= 30, "first page must respect limit");
  assert(first.nextCursor, "first page must include nextCursor when more cards exist");

  const second = await api(`/cards?account_id=1&stage_key=qualificado&limit=30&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert(second.cards.length <= 30, "second page must respect limit");

  const firstIds = new Set(first.cards.map((card) => String(card.id)));
  const duplicated = second.cards.some((card) => firstIds.has(String(card.id)));
  assert(!duplicated, "cursor pagination must not duplicate cards between pages");

  console.log(JSON.stringify({ ok: true, created: createdIds.length, firstPage: first.cards.length, secondPage: second.cards.length }));
} finally {
  for (const cardId of createdIds) {
    await api(`/cards/${encodeURIComponent(cardId)}`, { method: "DELETE" }).catch(() => null);
  }
}
