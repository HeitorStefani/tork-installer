const baseUrl = process.env.KANBAN_BASE_URL || "http://127.0.0.1:8080/api/v1";
const apiKey = process.env.KANBAN_API_KEY;

if (!apiKey) {
  throw new Error("KANBAN_API_KEY is required");
}

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
  if (!response.ok || payload.ok === false) {
    throw new Error(`${path}: ${payload.error || response.status}`);
  }
  return payload.data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const uniqueConversationId = Number(`9${Date.now().toString().slice(-11)}`);
let cardId = null;

try {
  const board = await api("/boards?account_id=1&limit=1");
  assert(Array.isArray(board.stages), "board.stages must be an array");
  assert(board.stages.every((stage) => stage.page && typeof stage.totalCards === "number"), "stages must include pagination metadata");

  const qualified = board.stages.find((stage) => stage.key === "qualificado") || board.stages[0];
  const firstPage = await api(`/cards?account_id=1&stage_key=${encodeURIComponent(qualified.key)}&limit=1`);
  assert(Array.isArray(firstPage.cards), "cards page must include cards array");
  assert("nextCursor" in firstPage, "cards page must include nextCursor");

  const appointmentAt = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const created = await api("/cards/upsert", {
    method: "POST",
    body: JSON.stringify({
      account_id: 1,
      conversation_id: uniqueConversationId,
      stage_key: "confirmado",
      contact_name: "Smoke Test Feedback",
      contact_phone: "+5500000000000",
      service: "Teste",
      observation: "Card temporario para teste de feedback",
      appointment_at: appointmentAt,
      metadata: { smokeTest: true },
    }),
  });
  cardId = created.id;
  assert(created.appointmentAt, "created card must expose appointmentAt");
  assert(created.feedbackDueAt, "created card must expose feedbackDueAt");

  const due = await api("/feedbacks/due?account_id=1&limit=20");
  assert(due.some((card) => String(card.id) === String(cardId)), "temporary card must be due for feedback");

  const registered = await api(`/feedbacks/${encodeURIComponent(cardId)}/register`, { method: "POST" });
  assert(registered.feedbackSentAt, "registered feedback must set feedbackSentAt");

  const dueAfterRegister = await api("/feedbacks/due?account_id=1&limit=20");
  assert(!dueAfterRegister.some((card) => String(card.id) === String(cardId)), "registered feedback must leave due queue");

  console.log(JSON.stringify({ ok: true, boardStages: board.stages.length, testedCardId: cardId }));
} finally {
  if (cardId) {
    await api(`/cards/${encodeURIComponent(cardId)}`, { method: "DELETE" }).catch(() => null);
  }
}
