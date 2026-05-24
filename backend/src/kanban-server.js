import http from "node:http";
import fs from "node:fs";
import { URL } from "node:url";
import pg from "pg";
import { config, requireConfig } from "./config.js";
import { ensureBoardForAccount, ensureDefaultBoard, migrate, pool, query } from "./db.js";

const { Pool } = pg;
const chatwootPool = config.chatwootDatabaseUrl
  ? new Pool({
      connectionString: config.chatwootDatabaseUrl,
      max: 2,
    })
  : null;

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": config.corsOrigin,
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Kanban-Api-Key, X-Kanban-Webhook-Secret",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const rateLimitBuckets = new Map();

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, jsonHeaders);
  res.end(JSON.stringify(body));
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    ...jsonHeaders,
    "Content-Type": contentType,
  });
  res.end(body);
}

function notFound(res) {
  sendJson(res, 404, { ok: false, error: "Route not found" });
}

function routeError(res, error) {
  const statusCode = Number(error.statusCode || 500);
  sendJson(res, statusCode, {
    ok: false,
    error: statusCode >= 500 ? "Internal server error" : error.message || "Request failed",
  });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJson(req) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > config.maxJsonBodyBytes) {
      throw httpError(413, "JSON body too large");
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};

  const contentType = String(req.headers["content-type"] || "");
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw httpError(415, "Content-Type must be application/json");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function rateLimitKey(req, url) {
  const coarsePath = url.pathname.startsWith("/api/v1/events") ? "/api/v1/events" : url.pathname;
  return `${clientIp(req)}:${req.method}:${coarsePath}`;
}

function enforceRateLimit(req, url) {
  if (config.rateLimitMaxRequests <= 0) return;
  if (url.pathname === "/health" || url.pathname === "/ready") return;

  const now = Date.now();
  const windowMs = Math.max(config.rateLimitWindowMs, 1000);
  const key = rateLimitKey(req, url);
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  bucket.count += 1;
  if (bucket.count > config.rateLimitMaxRequests) {
    throw httpError(429, "Too many requests");
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
}, Math.max(config.rateLimitWindowMs, 1000)).unref();

function requireApiKey(req, url = null) {
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const token = bearer || req.headers["x-kanban-api-key"] || url?.searchParams?.get("apiKey") || "";

  if (!config.apiKey || token !== config.apiKey) {
    throw httpError(401, "Invalid or missing Kanban API key");
  }
}

const eventClients = new Set();
const assigneeSyncState = {
  running: false,
  lastRunByAccount: new Map(),
};

function sendEvent(client, event, data = {}) {
  client.res.write(`event: ${event}\n`);
  client.res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastEvent(accountId, event, data = {}) {
  for (const client of eventClients) {
    if (client.accountId && Number(client.accountId) !== Number(accountId)) continue;
    sendEvent(client, event, { ...data, accountId, ts: new Date().toISOString() });
  }
}

function handleEvents(req, res, url) {
  requireApiKey(req, url);

  const accountId = toNumber(url.searchParams.get("account_id"), config.defaultAccountId);
  res.writeHead(200, {
    ...jsonHeaders,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const client = { res, accountId };
  eventClients.add(client);
  sendEvent(client, "ready", { accountId, ts: new Date().toISOString() });

  const heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(": heartbeat\n\n");
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(client);
  });
}

function requireWebhookSecret(req, url) {
  if (!config.chatwootWebhookSecret) return;

  const secret = req.headers["x-kanban-webhook-secret"] || url.searchParams.get("secret");
  if (secret !== config.chatwootWebhookSecret) {
    throw httpError(401, "Invalid Chatwoot webhook secret");
  }
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  const [updatedAt, id] = Buffer.from(String(cursor), "base64url").toString("utf8").split("|");
  const parsedDate = isoDate(updatedAt);
  const parsedId = toNumber(id);
  return parsedDate && parsedId ? { updatedAt: parsedDate, id: parsedId } : null;
}

function encodeCursor(row) {
  if (!row?.updated_at || !row?.id) return null;
  return Buffer.from(`${new Date(row.updated_at).toISOString()}|${row.id}`).toString("base64url");
}

function appointmentDateFromInput(input, current = null) {
  const metadata = input.metadata || {};
  return isoDate(
    input.appointment_at ??
      input.appointmentAt ??
      input.scheduled_at ??
      input.scheduledAt ??
      input.agendamento_at ??
      input.data_agendamento ??
      metadata.appointment_at ??
      metadata.appointmentAt ??
      metadata.scheduled_at ??
      metadata.scheduledAt ??
      metadata.data_agendamento,
  ) || current?.appointment_at || null;
}

function feedbackDueFromAppointment(appointmentAt, current = null) {
  if (!appointmentAt) return null;
  if (current?.feedback_sent_at) return current.feedback_due_at || null;

  const date = new Date(appointmentAt);
  if (Number.isNaN(date.getTime())) return null;
  const endOfDay = new Date(date);
  endOfDay.setHours(21, 0, 0, 0);
  return endOfDay.toISOString();
}

async function followUpSettings(accountId = config.defaultAccountId) {
  const result = await query(
    `
      insert into kanban_settings (account_id, follow_up_after_hours, lost_after_attempts)
      values ($1, $2, $3)
      on conflict (account_id)
      do update set account_id = excluded.account_id
      returning *
    `,
    [accountId, config.followUpAfterHours, config.lostAfterAttempts],
  );

  const row = result.rows[0];
  return {
    accountId: row.account_id,
    followUpAfterHours: Number(row.follow_up_after_hours),
    lostAfterAttempts: Number(row.lost_after_attempts),
  };
}

async function updateFollowUpSettings(accountId, input = {}) {
  const current = await followUpSettings(accountId);
  const followUpAfterHours = clampNumber(
    input.follow_up_after_hours ?? input.followUpAfterHours,
    current.followUpAfterHours,
    0.01,
    720,
  );
  const lostAfterAttempts = Math.round(clampNumber(
    input.lost_after_attempts ?? input.lostAfterAttempts,
    current.lostAfterAttempts,
    1,
    20,
  ));

  const result = await query(
    `
      insert into kanban_settings (account_id, follow_up_after_hours, lost_after_attempts)
      values ($1, $2, $3)
      on conflict (account_id)
      do update set
        follow_up_after_hours = excluded.follow_up_after_hours,
        lost_after_attempts = excluded.lost_after_attempts,
        updated_at = now()
      returning *
    `,
    [accountId, followUpAfterHours, lostAfterAttempts],
  );

  const row = result.rows[0];
  const settings = {
    accountId: row.account_id,
    followUpAfterHours: Number(row.follow_up_after_hours),
    lostAfterAttempts: Number(row.lost_after_attempts),
  };
  broadcastEvent(accountId, "settings.updated", { settings });
  return settings;
}

function detectService(text, tags = []) {
  const source = normalizeText([text, ...tags].join(" "));

  if (source.includes("implante")) return "Implante";
  if (source.includes("clareamento")) return "Clareamento";
  if (source.includes("cardio")) return "Cardiologia";
  if (source.includes("dent")) return "Odontologia";
  if (source.includes("clinico") || source.includes("consulta")) return "Clinico geral";

  return "";
}

function detectStage(text, tags = []) {
  const source = normalizeText([text, ...tags].join(" "));

  if (source.includes("confirmad")) return "confirmado";
  if (source.includes("agend") || source.includes("marcar") || source.includes("horario")) return "agendamento";
  if (
    source.includes("preco") ||
    source.includes("valor") ||
    source.includes("quanto") ||
    source.includes("interesse") ||
    source.includes("orcamento")
  ) {
    return "qualificado";
  }

  return null;
}

function priorityFromStage(stageKey, text, tags = []) {
  const source = normalizeText([stageKey, text, ...tags].join(" "));

  if (stageKey === "follow-up" || stageKey === "perdido" || source.includes("sem resposta")) return "risk";
  if (source.includes("preco") || source.includes("valor") || source.includes("interesse")) return "hot";
  return "normal";
}

function pickContactName(payload) {
  return (
    payload.sender?.name ||
    payload.conversation?.contact?.name ||
    payload.contact?.name ||
    payload.contact_name ||
    ""
  );
}

function pickContactPhone(payload) {
  return (
    payload.sender?.phone_number ||
    payload.conversation?.contact?.phone_number ||
    payload.contact?.phone_number ||
    payload.contact_phone ||
    ""
  );
}

function pickContactAvatar(payload) {
  return (
    payload.sender?.thumbnail ||
    payload.sender?.avatar_url ||
    payload.meta?.sender?.thumbnail ||
    payload.meta?.sender?.avatar_url ||
    payload.conversation?.contact?.thumbnail ||
    payload.contact?.thumbnail ||
    payload.contact_avatar_url ||
    ""
  );
}

function pickAssignedAgent(payload) {
  const assignee =
    payload.conversation?.meta?.assignee ||
    payload.conversation?.assignee ||
    payload.conversation?.assigned_agent ||
    payload.conversation?.assignee_user ||
    payload.meta?.assignee ||
    payload.meta?.assigned_agent ||
    payload.assignee ||
    payload.assigned_agent ||
    payload.agent ||
    {};

  return {
    id: assignee.id || assignee.user_id || assignee.assignee_id || payload.assignee_id || payload.conversation?.assignee_id || null,
    name: assignee.name || assignee.available_name || assignee.email || "",
    avatarUrl: assignee.thumbnail || assignee.avatar_url || assignee.avatar || "",
  };
}

function pickAssigneeId(payload) {
  const changed = Array.isArray(payload.changed_attributes) ? payload.changed_attributes : [];
  const changedAssignee = changed.find(
    (item) => item.assignee_id || item.assignee || item.attribute_name === "assignee_id" || item.name === "assignee_id",
  );
  const changedValue =
    changedAssignee?.assignee_id?.current_value ||
    changedAssignee?.assignee?.current_value ||
    changedAssignee?.current_value ||
    changedAssignee?.value;

  return (
    payload.assignee_id ||
    payload.conversation?.assignee_id ||
    payload.conversation?.meta?.assignee?.id ||
    payload.meta?.assignee?.id ||
    changedValue ||
    null
  );
}

function localChatwootAvatarUrl(accountId, assigneeId) {
  if (!assigneeId) return "";
  const baseUrl = (config.publicBaseUrl || "").replace(/\/$/, "");
  return `${baseUrl}/api/v1/chatwoot/agents/${encodeURIComponent(assigneeId)}/avatar?account_id=${encodeURIComponent(accountId)}`;
}

async function fetchChatwootAgentFromDatabase(accountId, assigneeId) {
  if (!chatwootPool || !assigneeId) return null;

  const result = await chatwootPool
    .query(
      `
        select u.id,
               u.name,
               u.display_name,
               u.email,
               u.custom_attributes,
               u.ui_settings,
               b.key as avatar_key
        from users u
        join account_users au on au.user_id = u.id
        left join active_storage_attachments a
          on a.record_type = 'User'
         and a.record_id = u.id
         and a.name = 'avatar'
        left join active_storage_blobs b
          on b.id = a.blob_id
        where au.account_id = $1
          and u.id = $2
        limit 1
      `,
      [accountId, assigneeId],
    )
    .catch(() => null);

  const agent = result?.rows?.[0];
  if (!agent) return null;

  return {
    id: agent.id,
    name: agent.display_name || agent.name || agent.email || `Atendente #${assigneeId}`,
    avatarUrl:
      agent.custom_attributes?.avatar_url ||
      agent.custom_attributes?.avatar ||
      agent.ui_settings?.avatar_url ||
      agent.ui_settings?.avatar ||
      (agent.avatar_key ? localChatwootAvatarUrl(accountId, assigneeId) : ""),
  };
}

async function fetchChatwootConversationAssignee(accountId, conversationId) {
  if (!chatwootPool || !conversationId) return null;

  const result = await chatwootPool
    .query(
      `
        select assignee_id
        from conversations
        where account_id = $1
          and (id = $2 or display_id = $2)
        order by updated_at desc
        limit 1
      `,
      [accountId, conversationId],
    )
    .catch(() => null);

  const assigneeId = result?.rows?.[0]?.assignee_id;
  if (!assigneeId) return null;
  return fetchChatwootAgentFromDatabase(accountId, assigneeId);
}

function formatChatwootAssignment(accountId, row) {
  const assigneeId = row?.assignee_id;
  if (!assigneeId) {
    return { id: null, name: "IA", avatarUrl: "" };
  }

  return {
    id: assigneeId,
    name: row.display_name || row.name || row.email || `Atendente #${assigneeId}`,
    avatarUrl:
      row.custom_attributes?.avatar_url ||
      row.custom_attributes?.avatar ||
      row.ui_settings?.avatar_url ||
      row.ui_settings?.avatar ||
      (row.avatar_key ? localChatwootAvatarUrl(accountId, assigneeId) : ""),
  };
}

async function syncChatwootAssigneesForAccount(accountId, { force = false } = {}) {
  if (!chatwootPool) return 0;

  const now = Date.now();
  const lastRun = assigneeSyncState.lastRunByAccount.get(Number(accountId)) || 0;
  const minIntervalMs = Math.max(config.chatwootAssigneeSyncSeconds, 1) * 1000;
  if (!force && now - lastRun < minIntervalMs) return 0;
  assigneeSyncState.lastRunByAccount.set(Number(accountId), now);

  const cardResult = await query(
    `
      select c.id, c.account_id, c.conversation_id, c.assigned_agent_name, c.assigned_agent_avatar_url
      from cards c
      join stages s on s.id = c.stage_id
      where c.account_id = $1
        and c.conversation_id is not null
        and s.key <> 'perdido'
      order by c.updated_at desc
      limit 500
    `,
    [accountId],
  );

  const cards = cardResult.rows;
  const conversationIds = [
    ...new Set(
      cards
        .map((card) => Number(card.conversation_id))
        .filter((conversationId) => Number.isInteger(conversationId) && conversationId > 0 && conversationId <= 2147483647),
    ),
  ];
  if (!conversationIds.length) return 0;

  const chatwootResult = await chatwootPool
    .query(
      `
        select c.id,
               c.display_id,
               c.assignee_id,
               u.name,
               u.display_name,
               u.email,
               u.custom_attributes,
               u.ui_settings,
               b.key as avatar_key
        from conversations c
        left join users u on u.id = c.assignee_id
        left join active_storage_attachments a
          on a.record_type = 'User'
         and a.record_id = u.id
         and a.name = 'avatar'
        left join active_storage_blobs b on b.id = a.blob_id
        where c.account_id = $1
          and (c.id = any($2::integer[]) or c.display_id = any($2::integer[]))
      `,
      [accountId, conversationIds],
    )
    .catch((error) => {
      console.warn("Chatwoot assignee sync failed:", error.message);
      return null;
    });

  const rows = chatwootResult?.rows || [];
  const byConversationId = new Map(rows.map((row) => [String(row.id), row]));
  const byDisplayId = new Map(rows.map((row) => [String(row.display_id), row]));
  let changed = 0;

  for (const card of cards) {
    const row = byConversationId.get(String(card.conversation_id)) || byDisplayId.get(String(card.conversation_id));
    if (!row) continue;

    const assignment = formatChatwootAssignment(accountId, row);
    const nextName = assignment.name || "IA";
    const nextAvatarUrl = assignment.avatarUrl || "";
    if ((card.assigned_agent_name || "") === nextName && (card.assigned_agent_avatar_url || "") === nextAvatarUrl) {
      continue;
    }

    const result = await query(
      `
        update cards
        set assigned_agent_name = $1,
            assigned_agent_avatar_url = $2,
            updated_at = now()
        where id = $3
        returning *
      `,
      [nextName, nextAvatarUrl, card.id],
    );
    const formatted = formatCard(await cardById(result.rows[0].id));

    await query(
      `
        insert into card_events (card_id, account_id, conversation_id, event_type, payload)
        values ($1, $2, $3, 'assignee.synced', $4::jsonb)
      `,
      [card.id, accountId, card.conversation_id, JSON.stringify({ assigneeId: assignment.id, name: nextName })],
    );

    changed += 1;
    broadcastEvent(accountId, "card.updated", { card: formatted });
  }

  return changed;
}

async function syncAllChatwootAssignees() {
  if (!chatwootPool || assigneeSyncState.running) return;
  assigneeSyncState.running = true;

  try {
    const result = await query("select distinct account_id from cards order by account_id");
    for (const row of result.rows) {
      await syncChatwootAssigneesForAccount(row.account_id, { force: true });
    }
  } catch (error) {
    console.warn("Chatwoot assignee sync failed:", error.message);
  } finally {
    assigneeSyncState.running = false;
  }
}

function startChatwootAssigneeSync() {
  if (!chatwootPool || config.chatwootAssigneeSyncSeconds <= 0) return;

  const intervalMs = Math.max(config.chatwootAssigneeSyncSeconds, 1) * 1000;
  setTimeout(syncAllChatwootAssignees, 1500);
  setInterval(syncAllChatwootAssignees, intervalMs);
  console.log(`Chatwoot assignee sync enabled every ${Math.round(intervalMs / 1000)}s`);
}

async function fetchChatwootAgent(accountId, assigneeId) {
  if (!assigneeId) return null;

  if (config.chatwootBaseUrl && config.chatwootApiToken) {
    const baseUrl = config.chatwootBaseUrl.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/api/v1/accounts/${accountId}/agents`, {
      headers: { api_access_token: config.chatwootApiToken },
    }).catch(() => null);

    if (response?.ok) {
      const data = await response.json().catch(() => ({}));
      const agents = data.payload || data.data || data || [];
      const agent = Array.isArray(agents)
        ? agents.find((item) => String(item.id || item.user_id) === String(assigneeId))
        : null;

      if (agent) {
        return {
          id: agent.id || agent.user_id || assigneeId,
          name: agent.name || agent.available_name || agent.email || `Atendente #${assigneeId}`,
          avatarUrl: agent.thumbnail || agent.avatar_url || agent.avatar || "",
        };
      }
    }
  }

  return fetchChatwootAgentFromDatabase(accountId, assigneeId);
}

async function resolveAssignedAgent(payload, accountId) {
  const picked = pickAssignedAgent(payload);
  if (picked.name || picked.avatarUrl) return picked;

  const assigneeId = picked.id || pickAssigneeId(payload);
  const fetched = await fetchChatwootAgent(accountId, assigneeId);
  return fetched || { id: assigneeId, name: assigneeId ? `Atendente #${assigneeId}` : "", avatarUrl: "" };
}

function normalizeSource(value) {
  const source = normalizeText(value);

  if (source.includes("instagram")) return { key: "instagram", label: "Instagram" };
  if (source.includes("facebook") || source.includes("messenger")) return { key: "facebook", label: "Facebook" };
  if (source.includes("telegram")) return { key: "telegram", label: "Telegram" };
  if (source.includes("email") || source.includes("mail")) return { key: "email", label: "Email" };
  if (source.includes("whatsapp") || source.includes("channel::api")) return { key: "whatsapp", label: "WhatsApp" };
  if (source.includes("chatwoot")) return { key: "chatwoot", label: "Chatwoot" };

  return value ? { key: source.replace(/[^a-z0-9]+/g, "-") || "chatwoot", label: String(value) } : null;
}

function pickSource(payload) {
  const values = [
    payload.source,
    payload.platform,
    payload.channel,
    payload.conversation?.channel,
    payload.inbox?.name,
    payload.inbox?.channel_type,
    payload.inbox?.provider,
    payload.meta?.channel,
    payload.sender?.source_id,
    payload.contact?.source_id,
  ];

  return normalizeSource(values.filter(Boolean).join(" "));
}

function customObservation(payload) {
  const custom =
    payload.conversation?.custom_attributes ||
    payload.conversation?.additional_attributes ||
    payload.custom_attributes ||
    {};

  return (
    custom.observacao ||
    custom.observacoes ||
    custom.observation ||
    custom.notes ||
    payload.observation ||
    ""
  );
}

function formatCard(row) {
  const metadata = row.metadata || {};

  return {
    id: String(row.id),
    boardId: String(row.board_id),
    stageId: String(row.stage_id),
    stageKey: row.stage_key,
    accountId: row.account_id,
    conversationId: String(row.conversation_id),
    contactId: row.contact_id ? String(row.contact_id) : null,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    contactAvatarUrl: row.contact_avatar_url,
    assignedAgentName: row.assigned_agent_name,
    assignedAgentAvatarUrl: row.assigned_agent_avatar_url,
    service: row.service,
    observation: row.observation,
    tags: row.tags || [],
    priority: row.priority,
    followUpAttempts: row.follow_up_attempts,
    appointmentAt: isoDate(row.appointment_at),
    feedbackDueAt: isoDate(row.feedback_due_at),
    feedbackSentAt: isoDate(row.feedback_sent_at),
    feedbackAttempts: row.feedback_attempts || 0,
    lastMessageAt: isoDate(row.last_message_at),
    lastIncomingAt: isoDate(row.last_incoming_at),
    nextFollowUpAt: isoDate(row.next_follow_up_at),
    source: metadata.source || "",
    sourceLabel: metadata.sourceLabel || metadata.source_label || metadata.inboxName || "",
    metadata,
    position: row.position,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  };
}

function formatStage(row, cards = []) {
  return {
    id: String(row.id),
    key: row.key,
    name: row.name,
    subtitle: row.subtitle,
    color: row.color,
    automation: row.automation || {},
    position: row.position,
    cards,
  };
}

async function getStage(boardId, key) {
  const result = await query("select * from stages where board_id = $1 and key = $2", [boardId, key]);
  return result.rows[0] || null;
}

async function createStage(input) {
  const accountId = toNumber(input.account_id ?? input.accountId, config.defaultAccountId);
  const board = await ensureBoardForAccount(accountId);
  const key = normalizeText(input.key || input.name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!key) throw httpError(400, "Stage key or name is required");
  if (!input.name) throw httpError(400, "Stage name is required");

  const positionResult = await query("select coalesce(max(position), 0) + 10 as position from stages where board_id = $1", [
    board.id,
  ]);
  const position = toNumber(input.position, Number(positionResult.rows[0].position));

  const result = await query(
    `
      insert into stages (board_id, key, name, subtitle, color, position, automation)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb)
      returning *
    `,
    [
      board.id,
      key,
      input.name,
      input.subtitle || "",
      input.color || "#5da7e8",
      position,
      JSON.stringify(input.automation || {}),
    ],
  );

  const formatted = formatStage(result.rows[0]);
  broadcastEvent(accountId, "stage.created", { stage: formatted });
  return formatted;
}

async function updateStage(stageId, input) {
  const currentResult = await query("select * from stages where id = $1", [stageId]);
  const current = currentResult.rows[0];
  if (!current) throw httpError(404, "Stage not found");

  const key =
    input.key === undefined
      ? current.key
      : normalizeText(input.key || input.name)
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");

  if (!key) throw httpError(400, "Stage key cannot be empty");

  const result = await query(
    `
      update stages
      set key = $1,
          name = $2,
          subtitle = $3,
          color = $4,
          position = $5,
          automation = $6::jsonb,
          updated_at = now()
      where id = $7
      returning *
    `,
    [
      key,
      input.name ?? current.name,
      input.subtitle ?? current.subtitle,
      input.color ?? current.color,
      toNumber(input.position, current.position),
      JSON.stringify(input.automation ?? current.automation ?? {}),
      stageId,
    ],
  );

  const formatted = formatStage(result.rows[0]);
  const boardResult = await query("select account_id from boards where id = $1", [current.board_id]);
  broadcastEvent(boardResult.rows[0]?.account_id, "stage.updated", { stage: formatted });
  return formatted;
}

async function deleteStage(stageId) {
  const stageResult = await query("select * from stages where id = $1", [stageId]);
  const stage = stageResult.rows[0];
  if (!stage) throw httpError(404, "Stage not found");

  const countResult = await query("select count(*)::int as total from cards where stage_id = $1", [stageId]);
  if (countResult.rows[0].total > 0) {
    throw httpError(409, "Move or remove cards before deleting this stage");
  }

  await query("delete from stages where id = $1", [stageId]);
  const formatted = formatStage(stage);
  const boardResult = await query("select account_id from boards where id = $1", [stage.board_id]);
  broadcastEvent(boardResult.rows[0]?.account_id, "stage.deleted", { stage: formatted });
  return formatted;
}

async function getStageById(boardId, stageId) {
  const result = await query("select * from stages where board_id = $1 and id = $2", [boardId, stageId]);
  return result.rows[0] || null;
}

async function cardById(cardId) {
  const result = await query(
    `
      select c.*, s.key as stage_key
      from cards c
      join stages s on s.id = c.stage_id
      where c.id = $1
    `,
    [cardId],
  );
  return result.rows[0] || null;
}

async function cardByConversation(accountId, conversationId) {
  const result = await query(
    `
      select c.*, s.key as stage_key
      from cards c
      join stages s on s.id = c.stage_id
      where c.account_id = $1 and c.conversation_id = $2
    `,
    [accountId, conversationId],
  );
  return result.rows[0] || null;
}

async function upsertCard(input) {
  const accountId = toNumber(input.account_id ?? input.accountId, config.defaultAccountId);
  const conversationId = toNumber(input.conversation_id ?? input.conversationId);

  if (!conversationId) {
    throw httpError(400, "conversation_id is required");
  }

  const board = await ensureBoardForAccount(accountId);
  const current = await cardByConversation(accountId, conversationId);
  const stageKey =
    input.stage_key ||
    input.stageKey ||
    (current ? current.stage_key : null) ||
    (input.auto_decide || input.autoDecide ? detectStage(input.observation || input.last_message || input.lastMessage, input.tags) : null) ||
    "novo";
  const stage = await getStage(board.id, stageKey);

  if (!stage) {
    throw httpError(400, `Unknown stage: ${stageKey}`);
  }

  const tags = asArray(input.tags);
  const settings = await followUpSettings(accountId);
  const now = new Date();
  const lastMessageAt = isoDate(input.last_message_at ?? input.lastMessageAt) || now.toISOString();
  const isIncoming = input.direction === "incoming" || input.message_type === "incoming" || input.messageType === "incoming";
  const resetFollowUpCycle =
    isIncoming ||
    input.reset_follow_up === true ||
    input.resetFollowUp === true ||
    (current?.follow_up_attempts > 0 && stage.key !== "follow-up" && stage.key !== "perdido");
  const lastIncomingAt = isIncoming
    ? lastMessageAt
    : isoDate(input.last_incoming_at ?? input.lastIncomingAt) || current?.last_incoming_at || null;
  const nextFollowUpAt =
    resetFollowUpCycle && !["confirmado", "perdido"].includes(stage.key)
      ? addHours(new Date(lastMessageAt), settings.followUpAfterHours)
      : isoDate(input.next_follow_up_at ?? input.nextFollowUpAt) || current?.next_follow_up_at || null;
  const observation = input.observation || input.last_message || input.lastMessage || current?.observation || "";
  const service = input.service || current?.service || detectService(observation, tags);
  const priority = input.priority || priorityFromStage(stage.key, observation, tags);
  const source =
    normalizeSource(
      input.source ||
        input.source_label ||
        input.sourceLabel ||
        input.platform ||
        input.metadata?.source ||
        input.metadata?.sourceLabel ||
        current?.metadata?.source ||
        current?.metadata?.sourceLabel ||
        "",
    ) || null;
  const metadata = {
    ...(current?.metadata || {}),
    ...(input.metadata || {}),
    ...(source ? { source: source.key, sourceLabel: source.label } : {}),
  };
  const appointmentAt = appointmentDateFromInput(input, current);
  const feedbackDueAt = isoDate(input.feedback_due_at ?? input.feedbackDueAt)
    || feedbackDueFromAppointment(appointmentAt, current);
  const explicitAssignedAgentName = input.assigned_agent_name ?? input.assignedAgentName;
  const explicitAssignedAgentAvatarUrl = input.assigned_agent_avatar_url ?? input.assignedAgentAvatarUrl;
  const currentAgentLooksAi = /(^|\s)(ia|ai|bot|robo|robô|assistente)(\s|$)/i.test(current?.assigned_agent_name || "");
  const chatwootAssignee =
    explicitAssignedAgentName || explicitAssignedAgentAvatarUrl || !current || currentAgentLooksAi
      ? await fetchChatwootConversationAssignee(accountId, conversationId)
      : null;

  const values = [
    board.id,
    stage.id,
    accountId,
    conversationId,
    input.contact_id ?? input.contactId ?? current?.contact_id ?? null,
    input.contact_name ?? input.contactName ?? current?.contact_name ?? "",
    input.contact_phone ?? input.contactPhone ?? current?.contact_phone ?? "",
    input.contact_avatar_url ?? input.contactAvatarUrl ?? current?.contact_avatar_url ?? "",
    explicitAssignedAgentName ?? chatwootAssignee?.name ?? current?.assigned_agent_name ?? "IA",
    explicitAssignedAgentAvatarUrl ?? chatwootAssignee?.avatarUrl ?? current?.assigned_agent_avatar_url ?? "",
    service,
    observation,
    tags.length ? tags : current?.tags || [],
    priority,
    resetFollowUpCycle ? 0 : input.follow_up_attempts ?? input.followUpAttempts ?? current?.follow_up_attempts ?? 0,
    appointmentAt,
    feedbackDueAt,
    current?.feedback_sent_at || null,
    input.feedback_attempts ?? input.feedbackAttempts ?? current?.feedback_attempts ?? 0,
    lastMessageAt,
    lastIncomingAt,
    nextFollowUpAt,
    JSON.stringify(metadata),
    input.position ?? current?.position ?? 0,
  ];

  const sql = current
    ? `
        update cards set
          board_id = $1,
          stage_id = $2,
          account_id = $3,
          conversation_id = $4,
          contact_id = $5,
          contact_name = $6,
          contact_phone = $7,
          contact_avatar_url = $8,
          assigned_agent_name = $9,
          assigned_agent_avatar_url = $10,
          service = $11,
          observation = $12,
          tags = $13,
          priority = $14,
          follow_up_attempts = $15,
          appointment_at = $16,
          feedback_due_at = $17,
          feedback_sent_at = $18,
          feedback_attempts = $19,
          last_message_at = $20,
          last_incoming_at = $21,
          next_follow_up_at = $22,
          metadata = $23::jsonb,
          position = $24,
          updated_at = now()
        where id = $25
        returning *
      `
    : `
        insert into cards (
          board_id, stage_id, account_id, conversation_id, contact_id, contact_name,
          contact_phone, contact_avatar_url, assigned_agent_name, assigned_agent_avatar_url,
          service, observation, tags, priority, follow_up_attempts, appointment_at,
          feedback_due_at, feedback_sent_at, feedback_attempts, last_message_at,
          last_incoming_at, next_follow_up_at, metadata, position
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19,
          $20, $21, $22, $23::jsonb, $24
        )
        returning *
      `;

  const result = await query(sql, current ? [...values, current.id] : values);
  const saved = await cardById(result.rows[0].id);

  await query(
    `
      insert into card_events (card_id, account_id, conversation_id, event_type, payload)
      values ($1, $2, $3, $4, $5::jsonb)
    `,
    [saved.id, accountId, conversationId, current ? "card.updated" : "card.created", JSON.stringify(input)],
  );

  const formatted = formatCard(saved);
  broadcastEvent(accountId, current ? "card.updated" : "card.created", { card: formatted });
  return formatted;
}

async function moveCard(cardId, stageKeyOrId) {
  const current = await cardById(cardId);
  if (!current) throw httpError(404, "Card not found");

  const stage = Number.isFinite(Number(stageKeyOrId))
    ? await getStageById(current.board_id, Number(stageKeyOrId))
    : await getStage(current.board_id, stageKeyOrId);

  if (!stage) throw httpError(400, "Stage not found");

  const result = await query(
    `
      update cards
      set stage_id = $1,
          priority = $2,
          updated_at = now()
      where id = $3
      returning *
    `,
    [stage.id, priorityFromStage(stage.key, current.observation, current.tags), cardId],
  );

  await query(
    `
      insert into card_events (card_id, account_id, conversation_id, event_type, payload)
      values ($1, $2, $3, 'card.moved', $4::jsonb)
    `,
    [
      current.id,
      current.account_id,
      current.conversation_id,
      JSON.stringify({ from: current.stage_key, to: stage.key }),
    ],
  );

  const formatted = formatCard({ ...result.rows[0], stage_key: stage.key });
  broadcastEvent(current.account_id, "card.moved", { card: formatted, from: current.stage_key, to: stage.key });
  return formatted;
}

async function deleteCard(cardId) {
  const current = await cardById(cardId);
  if (!current) throw httpError(404, "Card not found");

  await query("delete from card_events where card_id = $1", [cardId]);
  await query("delete from cards where id = $1", [cardId]);

  const formatted = formatCard(current);
  broadcastEvent(current.account_id, "card.deleted", { card: formatted });
  return formatted;
}

async function listCardsPage({ accountId, boardId, stageKey = "", limit = 20, cursor = "", search = "", agent = "", inbox = "" }) {
  const safeLimit = clampNumber(limit, 20, 1, 100);
  const decoded = decodeCursor(cursor);
  const params = [accountId, boardId, safeLimit + 1];
  const where = ["c.account_id = $1", "c.board_id = $2"];

  if (stageKey) {
    params.push(stageKey);
    where.push(`s.key = $${params.length}`);
  }

  if (decoded) {
    params.push(decoded.updatedAt, decoded.id);
    where.push(`(c.updated_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }

  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    where.push(`(
      lower(c.contact_name) like $${params.length}
      or lower(c.contact_phone) like $${params.length}
      or lower(c.service) like $${params.length}
      or lower(c.observation) like $${params.length}
      or lower(c.conversation_id::text) like $${params.length}
    )`);
  }

  if (agent) {
    params.push(agent);
    where.push(`c.assigned_agent_name = $${params.length}`);
  }

  if (inbox) {
    params.push(String(inbox));
    where.push(`c.metadata->>'inboxId' = $${params.length}`);
  }

  const result = await query(
    `
      select c.*, s.key as stage_key
      from cards c
      join stages s on s.id = c.stage_id
      where ${where.join(" and ")}
      order by c.updated_at desc, c.id desc
      limit $3
    `,
    params,
  );

  const rows = result.rows.slice(0, safeLimit);
  return {
    cards: rows.map(formatCard),
    nextCursor: result.rows.length > safeLimit ? encodeCursor(rows[rows.length - 1]) : null,
    limit: safeLimit,
  };
}

async function boardPayload(accountId, options = {}) {
  const board = await ensureBoardForAccount(accountId);
  await syncChatwootAssigneesForAccount(accountId);

  const stageResult = await query("select * from stages where board_id = $1 order by position asc", [board.id]);
  const countResult = await query(
    `
      select s.id as stage_id, count(c.id)::int as total
      from stages s
      left join cards c on c.stage_id = s.id
        and c.board_id = $1
        and c.account_id = $2
      where s.board_id = $1
      group by s.id
    `,
    [board.id, accountId],
  );
  const totals = new Map(countResult.rows.map((row) => [String(row.stage_id), row.total]));
  const cardsByStage = new Map();
  const pageLimit = clampNumber(options.limit, 20, 1, 100);

  for (const stage of stageResult.rows) {
    const page = await listCardsPage({
      accountId,
      boardId: board.id,
      stageKey: stage.key,
      limit: pageLimit,
    });
    cardsByStage.set(String(stage.id), page);
  }

  const stages = stageResult.rows.map((stage) => {
    const page = cardsByStage.get(String(stage.id)) || { cards: [], nextCursor: null, limit: pageLimit };
    return {
      ...formatStage(stage, page.cards),
      totalCards: totals.get(String(stage.id)) || 0,
      page: {
        limit: page.limit,
        nextCursor: page.nextCursor,
        hasMore: Boolean(page.nextCursor),
      },
    };
  });

  return {
    board: {
      id: String(board.id),
      accountId: board.account_id,
      name: board.name,
      description: board.description,
    },
    stages,
  };
}

async function handleCardsPage(url, res) {
  const accountId = toNumber(url.searchParams.get("account_id"), config.defaultAccountId);
  const board = await ensureBoardForAccount(accountId);
  await syncChatwootAssigneesForAccount(accountId);

  const page = await listCardsPage({
    accountId,
    boardId: board.id,
    stageKey: url.searchParams.get("stage_key") || url.searchParams.get("stageKey") || "",
    limit: url.searchParams.get("limit"),
    cursor: url.searchParams.get("cursor") || "",
    search: url.searchParams.get("q") || url.searchParams.get("search") || "",
    agent: url.searchParams.get("agent") || "",
    inbox: url.searchParams.get("inbox") || "",
  });

  sendJson(res, 200, { ok: true, data: page });
}

async function legacyBoardPayload(accountId) {
  const board = await ensureBoardForAccount(accountId);
  const stageResult = await query("select * from stages where board_id = $1 order by position asc", [board.id]);
  const cardResult = await query(
    `
      select c.*, s.key as stage_key
      from cards c
      join stages s on s.id = c.stage_id
      where c.board_id = $1
      order by s.position asc, c.position asc, c.updated_at desc
    `,
    [board.id],
  );

  const cards = cardResult.rows.map(formatCard);
  const stages = stageResult.rows.map((stage) => formatStage(stage, cards.filter((card) => card.stageId === String(stage.id))));

  return {
    board: {
      id: String(board.id),
      accountId: board.account_id,
      name: board.name,
      description: board.description,
    },
    stages,
  };
}

async function handleChatwootWebhook(req, res, url) {
  requireWebhookSecret(req, url);

  const body = await readJson(req);
  const payload = body.body || body;
  const messageType = payload.message_type || payload.type || "";

  const accountId = toNumber(payload.account?.id ?? payload.account_id, config.defaultAccountId);
  const conversationId = toNumber(payload.conversation?.id ?? payload.conversation_id);
  if (!conversationId) throw httpError(400, "Chatwoot payload missing conversation id");

  const assignedAgent = await resolveAssignedAgent(payload, accountId);
  const hasAssigneeUpdate = Boolean(assignedAgent.name || assignedAgent.avatarUrl || assignedAgent.id || pickAssigneeId(payload));

  if (messageType && messageType !== "incoming" && !hasAssigneeUpdate) {
    sendJson(res, 200, { ok: true, ignored: true, reason: "Only incoming messages or assignee changes update cards" });
    return;
  }

  const labels = asArray(payload.conversation?.labels || payload.labels);
  const content = payload.content || payload.message || "";
  const observation = customObservation(payload) || content || (messageType === "incoming" ? "Nova mensagem recebida no Chatwoot" : "");
  const createdAt =
    typeof payload.created_at === "number"
      ? new Date(payload.created_at * 1000).toISOString()
      : isoDate(payload.created_at);
  const source = pickSource(payload);
  const card = await upsertCard({
    account_id: accountId,
    conversation_id: conversationId,
    contact_id: payload.sender?.id || payload.contact?.id,
    contact_name: pickContactName(payload),
    contact_phone: pickContactPhone(payload),
    contact_avatar_url: pickContactAvatar(payload),
    assigned_agent_name: assignedAgent.name || undefined,
    assigned_agent_avatar_url: assignedAgent.avatarUrl || undefined,
    observation,
    last_message: content,
    last_message_at: createdAt,
    message_type: "incoming",
    tags: labels,
    source: source?.key,
    metadata: {
      chatwootMessageId: payload.id,
      inboxId: payload.inbox?.id || payload.inbox_id,
      inboxName: payload.inbox?.name || "",
      channel: payload.channel || payload.conversation?.channel || payload.inbox?.channel_type || "",
      ...(source ? { source: source.key, sourceLabel: source.label } : {}),
      rawConversationAttributes: payload.conversation?.custom_attributes || {},
    },
  });

  sendJson(res, 200, { ok: true, data: card });
}

async function handleChatwootAgentAvatar(agentId, url, res) {
  if (!chatwootPool) {
    notFound(res);
    return;
  }

  const accountId = toNumber(url.searchParams.get("account_id"), config.defaultAccountId);
  const result = await chatwootPool
    .query(
      `
        select b.key, b.content_type
        from users u
        join account_users au on au.user_id = u.id
        join active_storage_attachments a
          on a.record_type = 'User'
         and a.record_id = u.id
         and a.name = 'avatar'
        join active_storage_blobs b on b.id = a.blob_id
        where au.account_id = $1
          and u.id = $2
        limit 1
      `,
      [accountId, agentId],
    )
    .catch(() => null);

  const blob = result?.rows?.[0];
  if (!blob?.key || !/^[a-z0-9]+$/i.test(blob.key)) {
    notFound(res);
    return;
  }

  const storageRoot = config.chatwootStoragePath.replace(/\/$/, "");
  const avatarPath = `${storageRoot}/${blob.key.slice(0, 2)}/${blob.key.slice(2, 4)}/${blob.key}`;
  if (!fs.existsSync(avatarPath)) {
    notFound(res);
    return;
  }

  res.writeHead(200, {
    "Content-Type": blob.content_type || "image/jpeg",
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": config.corsOrigin,
  });
  fs.createReadStream(avatarPath).pipe(res);
}

async function handleDueFollowUps(url, res) {
  const accountId = toNumber(url.searchParams.get("account_id"), config.defaultAccountId);
  const limit = Math.min(toNumber(url.searchParams.get("limit"), 50), 100);
  const result = await query(
    `
      select c.*, s.key as stage_key
      from cards c
      join stages s on s.id = c.stage_id
      where c.account_id = $1
        and c.next_follow_up_at is not null
        and c.next_follow_up_at <= now()
        and s.key not in ('confirmado', 'perdido')
      order by c.next_follow_up_at asc
      limit $2
    `,
    [accountId, limit],
  );

  sendJson(res, 200, { ok: true, data: result.rows.map(formatCard) });
}

async function handleDueFeedbacks(url, res) {
  const accountId = toNumber(url.searchParams.get("account_id"), config.defaultAccountId);
  const limit = Math.min(toNumber(url.searchParams.get("limit"), 50), 100);
  const result = await query(
    `
      select c.*, s.key as stage_key
      from cards c
      join stages s on s.id = c.stage_id
      where c.account_id = $1
        and c.feedback_due_at is not null
        and c.feedback_due_at <= now()
        and c.feedback_sent_at is null
        and s.key in ('confirmado')
      order by c.feedback_due_at asc
      limit $2
    `,
    [accountId, limit],
  );

  sendJson(res, 200, { ok: true, data: result.rows.map(formatCard) });
}

async function handleRegisterFeedback(cardId, res) {
  const card = await cardById(cardId);
  if (!card) throw httpError(404, "Card not found");

  const result = await query(
    `
      update cards
      set feedback_sent_at = now(),
          feedback_attempts = feedback_attempts + 1,
          updated_at = now()
      where id = $1
      returning *
    `,
    [cardId],
  );

  await query(
    `
      insert into card_events (card_id, account_id, conversation_id, event_type, payload)
      values ($1, $2, $3, 'feedback.registered', $4::jsonb)
    `,
    [card.id, card.account_id, card.conversation_id, JSON.stringify({ feedbackSentAt: new Date().toISOString() })],
  );

  const formatted = formatCard({ ...result.rows[0], stage_key: card.stage_key });
  broadcastEvent(card.account_id, "card.updated", { card: formatted });
  sendJson(res, 200, { ok: true, data: formatted });
}

async function handleRegisterFollowUp(cardId, res) {
  const card = await cardById(cardId);
  if (!card) throw httpError(404, "Card not found");

  const settings = await followUpSettings(card.account_id);
  const followUpStage = await getStage(card.board_id, "follow-up");
  const lostStage = await getStage(card.board_id, "perdido");
  const attempts = card.follow_up_attempts + 1;
  const nextStage = attempts >= settings.lostAfterAttempts ? lostStage : followUpStage;

  const result = await query(
    `
      update cards
      set stage_id = $1::bigint,
          follow_up_attempts = $2::integer,
          next_follow_up_at = case when $2::integer >= $3::integer then null else now() + ($4::numeric || ' hours')::interval end,
          priority = $5,
          updated_at = now()
      where id = $6::bigint
      returning *
    `,
    [nextStage.id, attempts, settings.lostAfterAttempts, settings.followUpAfterHours, priorityFromStage(nextStage.key), cardId],
  );

  await query(
    `
      insert into card_events (card_id, account_id, conversation_id, event_type, payload)
      values ($1, $2, $3, 'follow_up.registered', $4::jsonb)
    `,
    [card.id, card.account_id, card.conversation_id, JSON.stringify({ attempts, nextStage: nextStage.key })],
  );

  const formatted = formatCard({ ...result.rows[0], stage_key: nextStage.key });
  broadcastEvent(card.account_id, "card.updated", { card: formatted });
  sendJson(res, 200, { ok: true, data: formatted });
}

async function handleScheduleFollowUp(cardId, req, res) {
  const card = await cardById(cardId);
  if (!card) throw httpError(404, "Card not found");

  const body = await readJson(req);
  const minutes = clampNumber(body.minutes ?? body.afterMinutes, null, 0, 43200);
  const hours = clampNumber(body.hours ?? body.afterHours, null, 0, 720);
  const explicitDate = isoDate(body.next_follow_up_at ?? body.nextFollowUpAt);
  const nextFollowUpAt = explicitDate
    || (minutes !== null ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : null)
    || (hours !== null ? addHours(new Date(), hours) : null);

  if (!nextFollowUpAt) {
    throw httpError(400, "Send minutes, hours, or next_follow_up_at");
  }

  const result = await query(
    `
      update cards
      set next_follow_up_at = $1,
          updated_at = now()
      where id = $2
      returning *
    `,
    [nextFollowUpAt, cardId],
  );

  await query(
    `
      insert into card_events (card_id, account_id, conversation_id, event_type, payload)
      values ($1, $2, $3, 'follow_up.scheduled', $4::jsonb)
    `,
    [card.id, card.account_id, card.conversation_id, JSON.stringify({ nextFollowUpAt })],
  );

  const formatted = formatCard({ ...result.rows[0], stage_key: card.stage_key });
  broadcastEvent(card.account_id, "card.updated", { card: formatted });
  sendJson(res, 200, { ok: true, data: formatted });
}

function dashboardScript() {
  const publicUrl = config.publicBaseUrl.replace(/\/$/, "");

  return `
(function () {
  if (window.__cwKanbanLoaded) return;
  window.__cwKanbanLoaded = true;

  var shell;
  var kanbanUrl = ${JSON.stringify(publicUrl)};

  function accountIdFromPath() {
    var match = window.location.pathname.match(/\\/accounts\\/(\\d+)/);
    return match ? match[1] : "";
  }

  function conversationIdFromPath() {
    var match = window.location.pathname.match(/\\/conversations\\/(\\d+)/);
    return match ? match[1] : "";
  }

  function sidebarRight() {
    var item = document.getElementById("cw-kanban-nav-item");
    var sidebar = item && item.closest("aside,nav,[role='navigation'],[class*='sidebar'],[class*='Sidebar']");
    var rect = sidebar && sidebar.getBoundingClientRect();
    return rect ? Math.max(64, Math.round(rect.right)) : 64;
  }

  function kanbanFrameUrl() {
    var url = kanbanUrl + "?embedded=chatwoot";
    var accountId = accountIdFromPath();
    var conversationId = conversationIdFromPath();
    if (accountId) url += "&accountId=" + encodeURIComponent(accountId);
    if (conversationId) url += "&conversationId=" + encodeURIComponent(conversationId);
    return url;
  }

  function ensureShell() {
    if (shell && document.body.contains(shell)) return shell;

    shell = document.createElement("section");
    shell.id = "cw-kanban-shell";
    shell.style.cssText = "position:fixed;top:0;right:0;bottom:0;left:64px;z-index:2147483000;background:#0d1115;color:#e6edf5;display:none;border-left:1px solid rgba(255,255,255,.08);box-shadow:-24px 0 80px rgba(0,0,0,.45)";

    var bar = document.createElement("div");
    bar.style.cssText = "height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.08);background:#101820;font:700 14px Inter,system-ui,sans-serif";
    bar.innerHTML = "<span>Kanban IA</span>";

    var close = document.createElement("button");
    close.type = "button";
    close.textContent = "Fechar";
    close.style.cssText = "height:32px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:#17212b;color:#e6edf5;font:700 12px Inter,system-ui,sans-serif;cursor:pointer";
    close.addEventListener("click", closeKanban);
    bar.appendChild(close);

    var frame = document.createElement("iframe");
    frame.title = "Kanban IA";
    frame.allow = "clipboard-read; clipboard-write";
    frame.style.cssText = "width:100%;height:calc(100% - 48px);border:0;background:#0d1115";

    shell.appendChild(bar);
    shell.appendChild(frame);
    document.body.appendChild(shell);
    return shell;
  }

  function openKanban(event) {
    if (event) event.preventDefault();
    var currentShell = ensureShell();
    currentShell.style.left = sidebarRight() + "px";
    currentShell.querySelector("iframe").src = kanbanFrameUrl();
    currentShell.style.display = "block";

    var item = document.getElementById("cw-kanban-nav-item");
    if (item) item.setAttribute("data-cw-kanban-active", "true");
  }

  function closeKanban() {
    if (shell) shell.style.display = "none";
    var item = document.getElementById("cw-kanban-nav-item");
    if (item) item.removeAttribute("data-cw-kanban-active");
  }

  window.addEventListener("message", function (event) {
    var data = event && event.data ? event.data : {};
    if (!data || data.type !== "kanban:openConversation") return;

    var accountId = data.accountId || accountIdFromPath();
    var conversationId = data.conversationId;
    if (!accountId || !conversationId) return;

    closeKanban();
    window.location.href = "/app/accounts/" + encodeURIComponent(accountId) + "/conversations/" + encodeURIComponent(conversationId);
  });

  function findConversationNavItem() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll("a[href],button,[role='button']"));
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var href = node.getAttribute("href") || "";
      var text = (node.textContent || "").trim().toLowerCase();
      if (href.indexOf("/conversations") !== -1 || text === "conversas" || text.indexOf("conversas") !== -1) {
        return node;
      }
    }
    return null;
  }

  function createNavLink(reference) {
    var link = document.createElement("a");
    link.id = "cw-kanban-nav-item";
    link.href = "#kanban-ia";
    link.setAttribute("title", "Kanban IA");
    link.setAttribute("aria-label", "Abrir Kanban IA");
    if (reference && reference.className && typeof reference.className === "string") {
      link.className = reference.className;
    }
    link.innerHTML = "<span style='display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:7px;background:#2787f5;color:#fff;font:800 11px Inter,system-ui,sans-serif'>K</span><span class='cw-kanban-label'>Kanban IA</span>";
    link.style.cssText += ";display:flex;align-items:center;gap:10px;text-decoration:none;cursor:pointer";
    link.addEventListener("click", openKanban);
    return link;
  }

  function mountNavItem() {
    if (document.getElementById("cw-kanban-nav-item")) return;

    var conversations = findConversationNavItem();
    var link = createNavLink(conversations);
    var target = conversations && (conversations.closest("li") || conversations);

    if (target && target.parentNode) {
      if (target.tagName && target.tagName.toLowerCase() === "li") {
        var li = document.createElement("li");
        li.appendChild(link);
        target.parentNode.insertBefore(li, target.nextSibling);
      } else {
        target.parentNode.insertBefore(link, target.nextSibling);
      }
      return;
    }

    var sidebar = document.querySelector("aside,nav,[role='navigation'],[class*='sidebar'],[class*='Sidebar']");
    if (sidebar) sidebar.appendChild(link);
  }

  function installStyles() {
    if (document.getElementById("cw-kanban-nav-style")) return;
    var style = document.createElement("style");
    style.id = "cw-kanban-nav-style";
    style.textContent = "#cw-kanban-nav-item[data-cw-kanban-active='true']{background:rgba(39,135,245,.16)!important;color:#fff!important}#cw-kanban-nav-item:hover{background:rgba(39,135,245,.12)!important;color:#fff!important}";
    document.head.appendChild(style);
  }

  installStyles();
  mountNavItem();
  setInterval(mountNavItem, 1500);
})();
`;
}

async function route(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  enforceRateLimit(req, url);

  if (pathname === "/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true, service: "chatwoot-kanban-backend" });
    return;
  }

  if (pathname === "/ready" && req.method === "GET") {
    await query("select 1");
    sendJson(res, 200, {
      ok: true,
      service: "chatwoot-kanban-backend",
      db: "ok",
      sseClients: eventClients.size,
      uptimeSeconds: Math.round(process.uptime()),
    });
    return;
  }

  if (pathname === "/dashboard-script.js" && req.method === "GET") {
    sendText(res, 200, dashboardScript(), "application/javascript; charset=utf-8");
    return;
  }

  if (pathname === "/webhooks/chatwoot" && req.method === "POST") {
    await handleChatwootWebhook(req, res, url);
    return;
  }

  if (!pathname.startsWith("/api/v1")) {
    notFound(res);
    return;
  }

  if (pathname === "/api/v1/events" && req.method === "GET") {
    handleEvents(req, res, url);
    return;
  }

  const agentAvatarMatch = pathname.match(/^\/api\/v1\/chatwoot\/agents\/(\d+)\/avatar$/);
  if (agentAvatarMatch && req.method === "GET") {
    await handleChatwootAgentAvatar(agentAvatarMatch[1], url, res);
    return;
  }

  requireApiKey(req, url);

  if (pathname === "/api/v1/settings" && req.method === "GET") {
    const accountId = toNumber(url.searchParams.get("account_id"), config.defaultAccountId);
    const followUp = await followUpSettings(accountId);
    sendJson(res, 200, {
      ok: true,
      data: {
        apiKey: config.apiKey,
        accountId,
        publicBaseUrl: config.publicBaseUrl,
        chatwootBaseUrl: config.chatwootBaseUrl,
        eventsUrl: "/api/v1/events",
        followUp,
      },
    });
    return;
  }

  if (pathname === "/api/v1/settings/follow-up" && req.method === "PATCH") {
    const body = await readJson(req);
    const accountId = toNumber(body.account_id ?? body.accountId ?? url.searchParams.get("account_id"), config.defaultAccountId);
    sendJson(res, 200, { ok: true, data: await updateFollowUpSettings(accountId, body) });
    return;
  }

  if (pathname === "/api/v1/boards" && req.method === "GET") {
    const accountId = toNumber(url.searchParams.get("account_id"), config.defaultAccountId);
    sendJson(res, 200, { ok: true, data: await boardPayload(accountId, { limit: url.searchParams.get("limit") }) });
    return;
  }

  if (pathname === "/api/v1/cards" && req.method === "GET") {
    await handleCardsPage(url, res);
    return;
  }

  if (pathname === "/api/v1/cards/upsert" && req.method === "POST") {
    const body = await readJson(req);
    sendJson(res, 200, { ok: true, data: await upsertCard(body) });
    return;
  }

  const moveMatch = pathname.match(/^\/api\/v1\/cards\/(\d+)\/stage$/);
  if (moveMatch && req.method === "PATCH") {
    const body = await readJson(req);
    const stageKeyOrId = body.stage_key || body.stageKey || body.stage_id || body.stageId;
    if (!stageKeyOrId) throw httpError(400, "stage_key or stage_id is required");
    sendJson(res, 200, { ok: true, data: await moveCard(moveMatch[1], stageKeyOrId) });
    return;
  }

  const cardMatch = pathname.match(/^\/api\/v1\/cards\/(\d+)$/);
  if (cardMatch && req.method === "DELETE") {
    sendJson(res, 200, { ok: true, data: await deleteCard(cardMatch[1]) });
    return;
  }

  if (pathname === "/api/v1/stages" && req.method === "POST") {
    const body = await readJson(req);
    sendJson(res, 201, { ok: true, data: await createStage(body) });
    return;
  }

  const stageMatch = pathname.match(/^\/api\/v1\/stages\/(\d+)$/);
  if (stageMatch && req.method === "PATCH") {
    const body = await readJson(req);
    sendJson(res, 200, { ok: true, data: await updateStage(stageMatch[1], body) });
    return;
  }

  if (stageMatch && req.method === "DELETE") {
    sendJson(res, 200, { ok: true, data: await deleteStage(stageMatch[1]) });
    return;
  }

  const conversationMatch = pathname.match(/^\/api\/v1\/conversations\/(\d+)\/card$/);
  if (conversationMatch && req.method === "GET") {
    const accountId = toNumber(url.searchParams.get("account_id"), config.defaultAccountId);
    const card = await cardByConversation(accountId, conversationMatch[1]);
    sendJson(res, 200, { ok: true, data: card ? formatCard(card) : null });
    return;
  }

  if (conversationMatch && req.method === "POST") {
    const body = await readJson(req);
    const accountId = toNumber(body.account_id ?? body.accountId ?? url.searchParams.get("account_id"), config.defaultAccountId);
    const card = await upsertCard({
      ...body,
      account_id: accountId,
      conversation_id: conversationMatch[1],
    });
    sendJson(res, 200, { ok: true, data: card });
    return;
  }

  if (pathname === "/api/v1/follow-ups/due" && req.method === "GET") {
    await handleDueFollowUps(url, res);
    return;
  }

  if (pathname === "/api/v1/feedbacks/due" && req.method === "GET") {
    await handleDueFeedbacks(url, res);
    return;
  }

  const followUpMatch = pathname.match(/^\/api\/v1\/follow-ups\/(\d+)\/register$/);
  if (followUpMatch && req.method === "POST") {
    await handleRegisterFollowUp(followUpMatch[1], res);
    return;
  }

  const feedbackMatch = pathname.match(/^\/api\/v1\/feedbacks\/(\d+)\/register$/);
  if (feedbackMatch && req.method === "POST") {
    await handleRegisterFeedback(feedbackMatch[1], res);
    return;
  }

  const followUpScheduleMatch = pathname.match(/^\/api\/v1\/follow-ups\/(\d+)\/schedule$/);
  if (followUpScheduleMatch && req.method === "POST") {
    await handleScheduleFollowUp(followUpScheduleMatch[1], req, res);
    return;
  }

  notFound(res);
}

async function main() {
  requireConfig();
  await migrate();
  await ensureDefaultBoard();

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => routeError(res, error));
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 65000;

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`Kanban backend listening on :${config.port}`);
  });

  startChatwootAssigneeSync();

  const shutdown = async (signal) => {
    console.log(`Received ${signal}, shutting down Kanban backend...`);
    server.close(async () => {
      await Promise.allSettled([
        pool.end(),
        chatwootPool?.end(),
      ]);
      process.exit(0);
    });

    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
