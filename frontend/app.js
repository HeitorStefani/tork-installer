const params = new URLSearchParams(window.location.search);
const config = window.KANBAN_CONFIG || {};
const apiBaseUrl = (config.apiBaseUrl || "/api/v1").replace(/\/$/, "");
const apiKey = params.get("apiKey") || config.apiKey || localStorage.getItem("KANBAN_API_KEY") || "";
const accountId = params.get("accountId") || config.accountId || 1;
const focusedConversationId = params.get("conversationId") || "";
const cardsPageLimit = 20;

const boardEl = document.querySelector("#board");
const boardNameEl = document.querySelector("#board-name");
const boardCountEl = document.querySelector("#board-count");
const statusEl = document.querySelector("#status");
const searchEl = document.querySelector("#search");
const refreshEl = document.querySelector("#refresh");
const addCardBtn = document.querySelector("#add-card");
const settingsBtn = document.querySelector("#board-settings");
const agentFilterBtn = document.querySelector("#agent-filter");
const inboxFilterBtn = document.querySelector("#inbox-filter");
const followupBtn = document.querySelector("#followup-button");
const docsBtn = document.querySelector("#docs-button");
const modalBackdrop = document.querySelector("#modal-backdrop");
const modalTitle = document.querySelector("#modal-title");
const modalBody = document.querySelector("#modal-body");
const modalClose = document.querySelector("#modal-close");

let boardData = null;
let searchTerm = "";
let selectedAgent = "";
let selectedInbox = "";
let realtimeSource = null;
let realtimeRetry = null;
let pollingTimer = null;
let reloadTimer = null;
let searchTimer = null;
let searchRequestId = 0;
let apiSettings = null;
let animatedCardId = "";
let loadingStageKey = "";

const sampleData = {
  board: { name: "Clinica Odontologica", accountId: 1 },
  stages: [
    {
      id: "1",
      key: "novo",
      name: "Novo Lead",
      subtitle: "Primeiro contato",
      color: "#5da7e8",
      cards: [
        {
          id: "sample-31",
          conversationId: "31",
          contactName: "Mariana Costa",
          contactPhone: "+55 17 98824-9714",
          assignedAgentName: "IA",
          source: "whatsapp",
          sourceLabel: "WhatsApp",
          service: "Odontopediatria",
          observation: "Chamou perguntando se a clinica atende crianca",
          tags: ["novo", "whatsapp"],
          priority: "normal",
          lastMessageAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
        },
      ],
    },
    {
      id: "2",
      key: "qualificado",
      name: "Qualificado",
      subtitle: "IA coletando informacoes",
      color: "#f2c84b",
      cards: [
        {
          id: "sample-23",
          conversationId: "23",
          contactName: "Lucas Moreira",
          contactPhone: "+55 11 94567-7788",
          assignedAgentName: "IA",
          source: "instagram",
          sourceLabel: "Instagram",
          service: "Implante",
          observation: "Cliente demonstrou interesse em implante",
          tags: ["preco", "interesse alto"],
          priority: "hot",
          lastMessageAt: new Date(Date.now() - 60 * 1000).toISOString(),
        },
      ],
    },
    { id: "3", key: "agendamento", name: "Agendamento", subtitle: "Horario em negociacao", color: "#9b78e6", cards: [] },
    { id: "4", key: "confirmado", name: "Confirmado", subtitle: "Paciente confirmou presenca", color: "#45a96c", cards: [] },
    { id: "5", key: "follow-up", name: "Follow-up", subtitle: "Sem resposta ha 24h", color: "#ec725b", cards: [] },
    { id: "6", key: "perdido", name: "Perdido", subtitle: "Cancelou ou nao respondeu", color: "#a8a7a5", cards: [] },
  ],
};

function setStatus(message, timeout = 4500) {
  statusEl.hidden = !message;
  statusEl.textContent = message || "";
  if (message && timeout) {
    window.clearTimeout(setStatus.timer);
    setStatus.timer = window.setTimeout(() => setStatus(""), timeout);
  }
}

function scheduleBoardReload(reason = "Atualizando em tempo real...") {
  if (searchTerm) return;

  window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    loadBoard({ silent: true, reason });
  }, 250);
}

function parseRealtimeEvent(event) {
  try {
    return JSON.parse(event.data || "{}");
  } catch {
    return {};
  }
}

function removeCardFromBoard(cardId) {
  if (!boardData?.stages) return null;

  for (const stage of boardData.stages) {
    const cards = stage.cards || [];
    const index = cards.findIndex((card) => String(card.id) === String(cardId));
    if (index >= 0) {
      return cards.splice(index, 1)[0];
    }
  }

  return null;
}

function findStageForCard(card) {
  if (!boardData?.stages || !card) return null;
  return boardData.stages.find((stage) => (
    String(stage.id) === String(card.stageId)
    || stage.key === card.stageKey
  ));
}

function animateCard(cardId) {
  animatedCardId = String(cardId || "");
  window.setTimeout(() => {
    if (animatedCardId === String(cardId)) {
      animatedCardId = "";
      document.querySelector(`[data-card-id="${CSS.escape(String(cardId))}"]`)?.classList.remove("realtime-move");
    }
  }, 1300);
}

function applyRealtimeCard(card, { deleted = false } = {}) {
  if (!card?.id || !boardData?.stages) return false;

  removeCardFromBoard(card.id);

  if (!deleted) {
    const target = findStageForCard(card);
    if (!target) return false;
    target.cards = target.cards || [];
    if (target.cards.some((existing) => String(existing.id) === String(card.id))) return true;
    target.cards.unshift(card);
    target.totalCards = Math.max(Number(target.totalCards || 0), target.cards.length);
    animateCard(card.id);
  }

  render();
  return true;
}

function handleRealtimeCardEvent(event, eventName) {
  const payload = parseRealtimeEvent(event);
  const card = payload.card;

  if (!card?.id) {
    scheduleBoardReload("Atualizado em tempo real.");
    return;
  }

  const applied = applyRealtimeCard(card, { deleted: eventName === "card.deleted" });
  if (!applied) scheduleBoardReload("Atualizado em tempo real.");
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Erro HTTP ${response.status}`);
  }

  return payload.data;
}

async function loadApiSettings() {
  if (apiSettings) return apiSettings;
  apiSettings = await api(`/settings?account_id=${encodeURIComponent(accountId)}`);
  return apiSettings;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function initials(name) {
  const parts = String(name || "Lead").trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() || "").join("") || "IA";
}

function hexToRgba(hex, opacity) {
  const clean = String(hex || "#5da7e8").replace("#", "");
  const value = clean.length === 3 ? clean.split("").map((char) => char + char).join("") : clean;
  const number = Number.parseInt(value, 16);
  const r = (number >> 16) & 255;
  const g = (number >> 8) & 255;
  const b = number & 255;
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function darkColumnBody(hex) {
  const clean = String(hex || "#5da7e8").replace("#", "");
  const number = Number.parseInt(clean, 16);
  const r = Math.max(13, Math.round(((number >> 16) & 255) * 0.12));
  const g = Math.max(15, Math.round(((number >> 8) & 255) * 0.12));
  const b = Math.max(18, Math.round((number & 255) * 0.12));
  return `rgb(${r}, ${g}, ${b})`;
}

function pillClass(priority) {
  if (priority === "hot") return "hot";
  if (priority === "risk") return "risk";
  return "active";
}

function pillLabel(priority) {
  if (priority === "hot") return "Quente";
  if (priority === "risk") return "Risco";
  return "Ativo";
}

function relativeTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMinutes = Math.max(1, Math.floor((Date.now() - date.getTime()) / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.floor(diffHours / 24)}d`;
}

function dueLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return "Hoje";
  if (date.toDateString() === yesterday.toDateString()) return "Ontem";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function allCards() {
  return (boardData?.stages || []).flatMap((stage) => stage.cards || []);
}

function stageCardCount(stage, visibleCards) {
  return Number(stage.totalCards ?? visibleCards.length ?? 0);
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
}

function normalizeSourceText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function sourceDetails(card = {}) {
  const raw = normalizeSourceText(
    [
      card.source,
      card.sourceLabel,
      card.metadata?.source,
      card.metadata?.sourceLabel,
      card.metadata?.source_label,
      card.metadata?.inboxName,
      card.metadata?.channel,
      card.metadata?.inboxId ? "whatsapp" : "",
      ...(card.tags || []),
    ].join(" "),
  );

  if (raw.includes("instagram")) return { key: "instagram", label: "Instagram", short: "IG" };
  if (raw.includes("facebook") || raw.includes("messenger")) return { key: "facebook", label: "Facebook", short: "FB" };
  if (raw.includes("telegram")) return { key: "telegram", label: "Telegram", short: "TG" };
  if (raw.includes("email") || raw.includes("mail")) return { key: "email", label: "Email", short: "@" };
  if (raw.includes("whatsapp") || card.contactPhone) return { key: "whatsapp", label: "WhatsApp", short: "WA" };
  return { key: "chatwoot", label: "Chatwoot", short: "CW" };
}

function avatarHtml(card, className = "avatar") {
  if (card.contactAvatarUrl) {
    return `<img class="${className}" src="${escapeHtml(card.contactAvatarUrl)}" alt="" />`;
  }
  return `<span class="${className} avatar-initials">${escapeHtml(initials(card.contactName))}</span>`;
}

function agentAvatarHtml(card) {
  const agentName = String(card.assignedAgentName || "IA");
  const isAi = /(^|\s)(ia|ai|bot|robo|robô|assistente)(\s|$)/i.test(agentName);

  if (!isAi && card.assignedAgentAvatarUrl) {
    return `<img class="agent-avatar" src="${escapeHtml(card.assignedAgentAvatarUrl)}" alt="${escapeHtml(agentName)}" />`;
  }

  if (isAi) {
    return `<span class="agent-avatar robot-avatar" aria-label="Atendimento por IA">🤖</span>`;
  }

  return `<span class="agent-avatar avatar-initials">${escapeHtml(initials(agentName))}</span>`;
}

function sourceIconHtml(source) {
  if (source.key === "whatsapp") {
    return `
      <svg class="source-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.2a8.6 8.6 0 0 0-7.4 13l-.9 4 4.1-1a8.6 8.6 0 1 0 4.2-16Zm0 1.8a6.8 6.8 0 0 1 0 13.6 6.7 6.7 0 0 1-3.5-1l-.4-.2-2 .5.4-1.9-.3-.4A6.8 6.8 0 0 1 12 5Zm-2.4 3.4c-.2 0-.5.1-.7.4-.3.3-.9.9-.9 2.1 0 1.2.9 2.4 1 2.6.1.2 1.7 2.7 4.3 3.6 2.1.8 2.5.4 3 .3.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2-.1-.1-.2-.2-.5-.3l-1.6-.8c-.2-.1-.4-.1-.6.2l-.7.9c-.1.2-.3.2-.5.1-.3-.1-1.1-.4-2-1.2-.8-.7-1.3-1.5-1.4-1.8-.1-.2 0-.4.1-.5l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.7-1.6c-.2-.4-.4-.4-.6-.4h-.7Z" />
      </svg>
    `;
  }

  return `<span class="source-short">${escapeHtml(source.short)}</span>`;
}

function findCard(cardId) {
  return allCards().find((card) => String(card.id) === String(cardId)) || null;
}

function firstValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function cardField(card, ...keys) {
  const sources = [card, card.metadata || {}, card.customAttributes || {}, card.additionalAttributes || {}];
  for (const source of sources) {
    for (const key of keys) {
      const value = firstValue(source?.[key]);
      if (value) return value;
    }
  }
  return "";
}

function cardDetails(card) {
  const observation = cardField(card, "observation", "observacao", "observação", "note", "notes", "resumo");
  const procedure = cardField(card, "procedure", "procedimento", "servico", "serviço", "service");
  const name = cardField(card, "nome", "name", "contactName", "cliente", "paciente");
  const preference = cardField(card, "preferencia", "preferência", "preference", "periodo", "periodo_preferido", "horario_preferido");
  const confirmed = cardField(card, "agendamentoConfirmado", "agendamento_confirmado", "confirmado", "status_agendamento");
  const professional = cardField(card, "profissional", "doctor", "dentista", "responsavel", "responsável");
  const dueDate = cardField(card, "dueDate", "prazo", "vencimento", "data_agendamento", "appointment_date", "nextAppointmentAt");
  const hasObservation = Boolean(observation || preference || confirmed || professional);

  return {
    observation,
    procedure,
    name,
    preference,
    confirmed,
    professional,
    dueDate,
    hasObservation,
  };
}

function cardTitle(card, details) {
  if (details.hasObservation && details.procedure && details.name) {
    return `[${details.procedure}] - ${details.name}`;
  }

  const sourceName = firstValue(card.metadata?.inboxName, card.metadata?.sourceLabel, card.sourceLabel, card.contactName, "fazer.ai");
  return `Conversa #${card.conversationId} - ${sourceName}`;
}

function detailLine(label, value) {
  if (!value) return "";
  return `<p class="detail-line"><span>${escapeHtml(label)}: </span>${escapeHtml(value)}</p>`;
}

function chatwootConversationUrl(card, settings = null) {
  const baseUrl = String(config.chatwootBaseUrl || settings?.chatwootBaseUrl || "").replace(/\/$/, "");
  if (!baseUrl || !card?.conversationId) return "";

  const targetAccountId = card.accountId || settings?.accountId || accountId;
  return `${baseUrl}/app/accounts/${encodeURIComponent(targetAccountId)}/conversations/${encodeURIComponent(card.conversationId)}`;
}

function navigateToConversation(url) {
  if (!url) return false;

  if (window.parent && window.parent !== window) {
    try {
      window.top.location.href = url;
      return true;
    } catch {
      window.open(url, "_blank", "noopener");
      return true;
    }
  }

  window.location.href = url;
  return true;
}

async function openConversation(card) {
  if (!card?.conversationId) return;

  const payload = {
    type: "kanban:openConversation",
    accountId: card.accountId || accountId,
    conversationId: card.conversationId,
  };

  if (window.parent && window.parent !== window) {
    window.parent.postMessage(payload, "*");
    setStatus("Abrindo conversa no Chatwoot...");
  }

  let targetUrl = chatwootConversationUrl(card);
  if (!targetUrl) {
    const settings = await loadApiSettings().catch(() => null);
    targetUrl = chatwootConversationUrl(card, settings);
  }

  if (navigateToConversation(targetUrl)) return;

  setStatus(`Nao encontrei a URL do Chatwoot para abrir a conversa #${card.conversationId}.`, 6000);
}

function cardMatches(card) {
  const agentOk = !selectedAgent || (card.assignedAgentName || "IA") === selectedAgent;
  const inboxValue = card.metadata?.inboxId ? String(card.metadata.inboxId) : "";
  const inboxOk = !selectedInbox || inboxValue === selectedInbox;

  if (!agentOk || !inboxOk) return false;
  if (!searchTerm) return true;

  const text = [
    card.contactName,
    card.contactPhone,
    card.service,
    card.observation,
    card.source,
    card.sourceLabel,
    card.metadata?.sourceLabel,
    card.metadata?.inboxName,
    card.conversationId,
    ...(card.tags || []),
  ]
    .join(" ")
    .toLowerCase();

  return text.includes(searchTerm);
}

function renderCard(card) {
  const details = cardDetails(card);
  const title = cardTitle(card, details);
  const isFocused = focusedConversationId && String(card.conversationId) === String(focusedConversationId);
  const source = sourceDetails(card);
  const followUps = Number(card.followUpAttempts || 0);
  const due = dueLabel(details.dueDate);

  return `
    <article class="card ${details.hasObservation ? "has-observation" : "compact"} ${String(card.id) === animatedCardId ? "realtime-move" : ""} ${isFocused ? "focused" : ""}" draggable="true" data-card-id="${escapeHtml(card.id)}" data-conversation-id="${escapeHtml(card.conversationId)}">
      <div class="card-head">
        <h3>${escapeHtml(title)}</h3>
        <div class="card-actions">
          <button type="button" class="card-action" data-action="edit-card" data-card-id="${escapeHtml(card.id)}" title="Editar card" aria-label="Editar card">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.7 2.9a2 2 0 0 1 2.8 2.8l-9.1 9.1-3.6.8.8-3.6 9.1-9.1Zm1.8 1.8-.9-.9-1.1 1.1.9.9 1.1-1.1ZM5.5 12.5l-.3 1.3 1.3-.3 7-7-.9-.9-7.1 6.9Z"/></svg>
          </button>
          <button type="button" class="card-action danger" data-action="delete-card" data-card-id="${escapeHtml(card.id)}" title="Apagar card" aria-label="Apagar card">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.3 6.2 1-1L10 8.9l3.7-3.7 1 1L11.1 10l3.6 3.8-1 1L10 11.1l-3.7 3.7-1-1L8.9 10 5.3 6.2Z"/></svg>
          </button>
        </div>
      </div>
      <div class="people">
        <div class="avatars">
          <span class="avatar-wrap" title="${escapeHtml(source.label)}">
            ${avatarHtml(card)}
            <span class="social-badge source-${escapeHtml(source.key)}">${sourceIconHtml(source)}</span>
          </span>
        </div>
        <span class="agent-wrap" title="${escapeHtml(card.assignedAgentName || "IA")}">
          ${agentAvatarHtml(card)}
          <span class="agent-status"></span>
        </span>
      </div>

      ${
        details.hasObservation
          ? `<div class="card-details">
              ${detailLine("Procedimento", details.procedure)}
              ${detailLine("Nome", details.name)}
              ${detailLine("Preferência", details.preference)}
              ${detailLine("Agendamento confirmado", details.confirmed)}
              ${detailLine("Profissional", details.professional)}
              ${detailLine("Observação", details.observation)}
            </div>`
          : ""
      }
      ${followUps ? `<p class="followup-count">Follow-ups enviados: ${escapeHtml(followUps)}</p>` : ""}
      <div class="card-footer">
        <span class="card-ids">Card #${escapeHtml(card.id)} · Conversa #${escapeHtml(card.conversationId)}</span>
        <span class="time">${due ? `<span class="due">${escapeHtml(due)}</span>` : ""}<span class="last-seen">◷ ${escapeHtml(relativeTime(card.lastMessageAt) || "agora")}</span></span>
      </div>
    </article>
  `;
}

function render() {
  if (!boardData) return;

  const stages = boardData.stages || [];
  const total = stages.reduce((sum, stage) => sum + Number(stage.totalCards ?? (stage.cards || []).length), 0);
  boardNameEl.textContent = boardData.board?.name || "Kanban IA";
  boardCountEl.textContent = String(total);
  agentFilterBtn.textContent = selectedAgent || "Todos os agentes";
  inboxFilterBtn.textContent = selectedInbox ? `Caixa ${selectedInbox}` : "Todas as caixas";

  boardEl.innerHTML = stages
    .map((stage) => {
      const cards = (stage.cards || []).filter(cardMatches);
      const style = [
        `--header:${stage.color}`,
        `--body:${darkColumnBody(stage.color)}`,
        `--border:${hexToRgba(stage.color, 0.35)}`,
        `--glow:0 0 28px ${hexToRgba(stage.color, 0.13)}`,
      ].join(";");

      return `
        <section class="column" style="${style}" data-stage-key="${escapeHtml(stage.key)}">
          <div class="column-header">
            <div>
              <div class="column-title">${escapeHtml(stage.name)} <span class="count">${stageCardCount(stage, cards)}</span></div>
              <div class="column-subtitle">${escapeHtml(stage.subtitle)}</div>
            </div>
            <div class="column-tools">
              <button type="button" data-action="edit-stage" data-stage-id="${escapeHtml(stage.id)}" onclick="window.KanbanUI?.openStage('${escapeHtml(stage.id)}')" title="Editar etapa">⚙</button>
              <button type="button" data-action="add-card" data-stage-key="${escapeHtml(stage.key)}" onclick="window.KanbanUI?.openCard('${escapeHtml(stage.key)}')" title="Adicionar card">+</button>
            </div>
          </div>
          <button class="add-task" type="button" data-action="add-card" data-stage-key="${escapeHtml(stage.key)}" onclick="window.KanbanUI?.openCard('${escapeHtml(stage.key)}')">+ Adicionar tarefa</button>
          <div class="cards">
            ${cards.length ? cards.map(renderCard).join("") : '<div class="empty">Nenhum card nesta etapa</div>'}
          </div>
          ${
            stage.page?.hasMore
              ? `<button class="load-more" type="button" data-action="load-more" data-stage-key="${escapeHtml(stage.key)}">
                  ${loadingStageKey === stage.key ? "Carregando..." : "Carregar mais"}
                </button>`
              : ""
          }
        </section>
      `;
    })
    .join("");

  bindBoardEvents();
}

function openModal(title, html, onReady) {
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalBackdrop.hidden = false;
  onReady?.(modalBody);
}

function closeModal() {
  modalBackdrop.hidden = true;
  modalBody.innerHTML = "";
}

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function splitTags(value) {
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function stageOptions(selectedKey = "") {
  return (boardData?.stages || [])
    .map((stage) => `<option value="${escapeHtml(stage.key)}" ${stage.key === selectedKey ? "selected" : ""}>${escapeHtml(stage.name)}</option>`)
    .join("");
}

function cardFormHtml(stageKey = "", card = null) {
  const values = card || {};
  const selectedStage = values.stageKey || stageKey || boardData?.stages?.[0]?.key;
  const tags = (values.tags || []).join(", ");
  const source = card ? sourceDetails(values) : { key: "whatsapp", label: "WhatsApp", short: "WA" };

  return `
    <form class="form-grid" id="card-form">
      <div class="field">
        <label>Etapa</label>
        <select name="stage_key">${stageOptions(selectedStage)}</select>
      </div>
      <div class="field">
        <label>Nome do cliente</label>
        <input name="contact_name" value="${escapeHtml(values.contactName || "")}" placeholder="Lucas Moreira" required />
      </div>
      <div class="field">
        <label>Telefone</label>
        <input name="contact_phone" value="${escapeHtml(values.contactPhone || "")}" placeholder="+5511999999999" />
      </div>
      <div class="field">
        <label>Avatar do cliente</label>
        <input name="contact_avatar_url" value="${escapeHtml(values.contactAvatarUrl || "")}" placeholder="https://..." />
      </div>
      <div class="field">
        <label>Origem</label>
        <select name="source">
          ${["whatsapp", "instagram", "facebook", "telegram", "email", "chatwoot"]
            .map((item) => `<option value="${item}" ${source.key === item ? "selected" : ""}>${escapeHtml(sourceDetails({ source: item }).label)}</option>`)
            .join("")}
        </select>
      </div>
      <div class="field">
        <label>Servico/interesse</label>
        <input name="service" value="${escapeHtml(values.service || "")}" placeholder="Implante, clareamento, consulta..." />
      </div>
      <div class="field">
        <label>Observacoes</label>
        <textarea name="observation" placeholder="Resumo do que sabemos sobre o cliente">${escapeHtml(values.observation || "")}</textarea>
      </div>
      <div class="field">
        <label>Tags</label>
        <input name="tags" value="${escapeHtml(tags)}" placeholder="preco, interesse alto" />
      </div>
      <div class="field">
        <label>ID da conversa</label>
        <input name="conversation_id" value="${escapeHtml(values.conversationId || "")}" inputmode="numeric" placeholder="Opcional para card manual" />
      </div>
      <div class="modal-actions">
        <button class="secondary-btn" type="button" data-action="cancel-modal" onclick="window.KanbanUI?.closeModal()">Cancelar</button>
        <button class="primary-btn" type="submit">Salvar card</button>
      </div>
    </form>
  `;
}

function openCardModal(stageKey = "", card = null) {
  openModal(card ? "Editar card" : "Adicionar tarefa", cardFormHtml(stageKey, card), (root) => {
    root.querySelector("#card-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = formObject(event.currentTarget);
      const conversationId = data.conversation_id || String(Date.now());

      try {
        await api("/cards/upsert", {
          method: "POST",
          body: JSON.stringify({
            account_id: Number(accountId),
            conversation_id: Number(conversationId),
            stage_key: data.stage_key,
            contact_name: data.contact_name,
            contact_phone: data.contact_phone,
            contact_avatar_url: data.contact_avatar_url,
            service: data.service,
            observation: data.observation,
            tags: splitTags(data.tags),
            source: data.source,
            metadata: card?.metadata || {},
          }),
        });
        closeModal();
        setStatus(card ? "Card atualizado." : "Card criado.");
        await loadBoard();
      } catch (error) {
        setStatus(`Nao consegui salvar o card: ${error.message}`);
      }
    });
  });
}

function openEditCardModal(cardId) {
  const card = findCard(cardId);
  if (!card) {
    setStatus("Card nao encontrado.");
    return;
  }

  openCardModal(card.stageKey, card);
}

async function deleteCard(cardId) {
  const card = findCard(cardId);
  if (!card) return;
  if (!window.confirm(`Apagar o card da conversa #${card.conversationId}?`)) return;

  try {
    await api(`/cards/${encodeURIComponent(cardId)}`, { method: "DELETE" });
    setStatus("Card apagado.");
    await loadBoard();
  } catch (error) {
    setStatus(`Nao consegui apagar o card: ${error.message}`);
  }
}

function stageFormHtml(stage = {}) {
  const isEditing = Boolean(stage.id);

  return `
    <form class="form-grid" id="stage-form">
      <div class="field">
        <label>Nome da etapa</label>
        <input name="name" value="${escapeHtml(stage.name || "")}" placeholder="Novo Lead" required />
      </div>
      <div class="field">
        <label>Chave tecnica</label>
        <input name="key" value="${escapeHtml(stage.key || "")}" placeholder="novo-lead" />
      </div>
      <div class="field">
        <label>Subtitulo</label>
        <input name="subtitle" value="${escapeHtml(stage.subtitle || "")}" placeholder="Primeiro contato" />
      </div>
      <div class="field">
        <label>Cor</label>
        <input name="color" type="color" value="${escapeHtml(stage.color || "#5da7e8")}" />
      </div>
      <div class="field">
        <label>Posicao</label>
        <input name="position" type="number" value="${escapeHtml(stage.position ?? "")}" />
      </div>
      <div class="modal-actions">
        ${isEditing ? '<button class="danger-btn" type="button" data-action="delete-stage">Excluir etapa</button>' : ""}
        <button class="secondary-btn" type="button" data-action="cancel-modal" onclick="window.KanbanUI?.closeModal()">Cancelar</button>
        <button class="primary-btn" type="submit">${isEditing ? "Salvar etapa" : "Criar etapa"}</button>
      </div>
    </form>
  `;
}

function openStageModal(stage = null) {
  const currentStage = stage || {};
  openModal(currentStage.id ? "Editar etapa" : "Nova etapa", stageFormHtml(currentStage), (root) => {
    const form = root.querySelector("#stage-form");

    form.addEventListener("input", (event) => {
      if (event.target.name === "name" && !form.elements.key.value) {
        form.elements.key.value = slugify(event.target.value);
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = formObject(event.currentTarget);
      const body = {
        account_id: Number(accountId),
        name: data.name,
        key: data.key || slugify(data.name),
        subtitle: data.subtitle,
        color: data.color,
        position: data.position ? Number(data.position) : undefined,
      };

      try {
        if (currentStage.id) {
          await api(`/stages/${encodeURIComponent(currentStage.id)}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          });
          setStatus("Etapa atualizada.");
        } else {
          await api("/stages", {
            method: "POST",
            body: JSON.stringify(body),
          });
          setStatus("Etapa criada.");
        }
        closeModal();
        await loadBoard();
      } catch (error) {
        setStatus(`Nao consegui salvar a etapa: ${error.message}`);
      }
    });

    root.querySelector('[data-action="delete-stage"]')?.addEventListener("click", async () => {
      if (!window.confirm("Excluir esta etapa? Ela precisa estar vazia.")) return;
      try {
        await api(`/stages/${encodeURIComponent(currentStage.id)}`, { method: "DELETE" });
        closeModal();
        setStatus("Etapa excluida.");
        await loadBoard();
      } catch (error) {
        setStatus(`Nao consegui excluir a etapa: ${error.message}`);
      }
    });
  });
}

function openFunnelManager() {
  const stages = boardData?.stages || [];
  openModal(
    "Editar funil",
    `
      <div class="stage-list">
        ${stages
          .map(
            (stage) => `
              <div class="stage-row">
                <span class="stage-swatch" style="background:${escapeHtml(stage.color)}"></span>
                <div>
                  <strong>${escapeHtml(stage.name)}</strong>
                  <span>${escapeHtml(stage.subtitle || "Sem subtitulo")} · ${stage.cards?.length || 0} cards</span>
                </div>
                <div class="stage-actions">
                  <button type="button" data-action="edit-stage" data-stage-id="${escapeHtml(stage.id)}" onclick="window.KanbanUI?.openStage('${escapeHtml(stage.id)}')">⚙</button>
                  <button type="button" data-action="add-card" data-stage-key="${escapeHtml(stage.key)}" onclick="window.KanbanUI?.openCard('${escapeHtml(stage.key)}')">+</button>
                </div>
              </div>
            `,
          )
          .join("")}
      </div>
      <div class="modal-actions">
        <button class="secondary-btn" type="button" data-action="cancel-modal" onclick="window.KanbanUI?.closeModal()">Fechar</button>
        <button class="primary-btn" type="button" data-action="new-stage" onclick="window.KanbanUI?.openStage()">Nova etapa</button>
      </div>
    `,
  );
}

function openFilterModal(type) {
  const isAgent = type === "agent";
  const options = isAgent
    ? uniqueValues(allCards().map((card) => card.assignedAgentName || "IA"))
    : uniqueValues(allCards().map((card) => (card.metadata?.inboxId ? String(card.metadata.inboxId) : "")));
  const current = isAgent ? selectedAgent : selectedInbox;

  openModal(
    isAgent ? "Filtrar agentes" : "Filtrar caixas",
    `
      <div class="stage-list">
        <button class="secondary-btn" type="button" data-filter-value="">${isAgent ? "Todos os agentes" : "Todas as caixas"}</button>
        ${
          options.length
            ? options
                .map(
                  (value) =>
                    `<button class="${value === current ? "primary-btn" : "secondary-btn"}" type="button" data-filter-value="${escapeHtml(value)}">${escapeHtml(isAgent ? value : `Caixa ${value}`)}</button>`,
                )
                .join("")
            : '<div class="empty">Nenhuma opcao encontrada ainda</div>'
        }
      </div>
    `,
    (root) => {
      root.querySelectorAll("[data-filter-value]").forEach((button) => {
        button.addEventListener("click", () => {
          if (isAgent) selectedAgent = button.dataset.filterValue;
          else selectedInbox = button.dataset.filterValue;
          closeModal();
          render();
        });
      });
    },
  );
}

function openDocsModal() {
  const baseUrl = window.location.origin;

  openModal(
    "API do Kanban",
    `
      <div class="docs">
        <section class="docs-section api-key-panel" id="api-key-panel">
          <h3>API Key do Kanban</h3>
          <p>Use esta chave no n8n e em integrações externas. Ela fica mascarada por padrão.</p>
          <div class="api-key-row">
            <input id="api-key-value" readonly value="Carregando..." />
            <button class="secondary-btn" type="button" data-action="toggle-api-key">Revelar</button>
            <button class="primary-btn" type="button" data-action="copy-api-key">Copiar</button>
          </div>
          <p class="api-key-hint" id="api-key-hint">Header: Authorization: Bearer &lt;API_KEY&gt;</p>
        </section>

        <section class="docs-section followup-panel" id="followup-panel">
          <h3>Configuração de follow-up</h3>
          <p>Define quando um card entra na fila de follow-up e quantas tentativas são feitas antes de ir para perdido.</p>
          <form class="settings-form" id="followup-settings-form">
            <label>
              <span>Horas até precisar de follow-up</span>
              <input name="follow_up_after_hours" type="number" min="0.01" max="720" step="0.01" placeholder="24" />
            </label>
            <label>
              <span>Tentativas até mover para perdido</span>
              <input name="lost_after_attempts" type="number" min="1" max="20" step="1" placeholder="2" />
            </label>
            <button class="primary-btn" type="submit">Salvar follow-up</button>
          </form>

          <div class="test-followup">
            <h4>Teste rápido</h4>
            <p>Agenda um card específico para aparecer como pendente daqui alguns minutos, sem esperar 24h.</p>
            <form class="settings-form" id="followup-test-form">
              <label>
                <span>ID do card</span>
                <input name="card_id" inputmode="numeric" placeholder="Ex: 28" />
              </label>
              <label>
                <span>Daqui quantos minutos?</span>
                <input name="minutes" type="number" min="0" max="43200" step="1" value="1" />
              </label>
              <button class="secondary-btn" type="submit">Agendar teste</button>
            </form>
          </div>

          <pre class="docs-code">${escapeHtml(`GET ${baseUrl}/api/v1/follow-ups/due?account_id=${accountId}&limit=50
POST ${baseUrl}/api/v1/follow-ups/{cardId}/register
POST ${baseUrl}/api/v1/follow-ups/{cardId}/schedule`)}</pre>
        </section>

        <section class="docs-section">
          <h3>Tempo real</h3>
          <p>O board escuta eventos em tempo real por SSE. Quando o n8n, Chatwoot ou outra aba cria/move/atualiza um card, esta tela recarrega automaticamente.</p>
          <pre class="docs-code">${escapeHtml(`GET ${baseUrl}/api/v1/events?account_id=${accountId}
Header:
Authorization: Bearer <KANBAN_API_KEY>`)}</pre>
        </section>

        <section class="docs-section">
          <h3>Base URL</h3>
          <p>Use este dominio nos nodes HTTP Request do n8n.</p>
          <pre class="docs-code">${escapeHtml(baseUrl)}</pre>
          <p>Se voce expor o backend direto, use header <strong>Authorization: Bearer KANBAN_API_KEY</strong>. No compose padrao, o Nginx do Kanban injeta a chave automaticamente nas rotas /api.</p>
        </section>

        <section class="docs-section">
          <h3>Rotas do board e funil</h3>
          <div class="route-list">
            <div class="route-row"><span class="method">GET</span><code>/health</code></div>
            <div class="route-row"><span class="method">GET</span><code>/api/v1/boards?account_id=${escapeHtml(accountId)}</code></div>
            <div class="route-row"><span class="method">POST</span><code>/api/v1/stages</code></div>
            <div class="route-row"><span class="method">PATCH</span><code>/api/v1/stages/:stageId</code></div>
            <div class="route-row"><span class="method">DELETE</span><code>/api/v1/stages/:stageId</code></div>
          </div>
          <pre class="docs-code">${escapeHtml(`POST /api/v1/stages
{
  "account_id": ${accountId},
  "name": "Negociacao",
  "key": "negociacao",
  "subtitle": "Cliente comparando opcoes",
  "color": "#38bdf8",
  "position": 70
}`)}</pre>
        </section>

        <section class="docs-section">
          <h3>Rotas de cards</h3>
          <div class="route-list">
            <div class="route-row"><span class="method">GET</span><code>/api/v1/cards?account_id=${escapeHtml(accountId)}</code></div>
            <div class="route-row"><span class="method">POST</span><code>/api/v1/cards/upsert</code></div>
            <div class="route-row"><span class="method">PATCH</span><code>/api/v1/cards/:cardId/stage</code></div>
            <div class="route-row"><span class="method">DELETE</span><code>/api/v1/cards/:cardId</code></div>
            <div class="route-row"><span class="method">GET</span><code>/api/v1/conversations/:conversationId/card?account_id=${escapeHtml(accountId)}</code></div>
            <div class="route-row"><span class="method">POST</span><code>/api/v1/conversations/:conversationId/card</code></div>
          </div>
          <pre class="docs-code">${escapeHtml(`POST /api/v1/cards/upsert
{
  "account_id": ${accountId},
  "conversation_id": 23,
  "stage_key": "qualificado",
  "contact_name": "Lucas Moreira",
  "contact_phone": "+5511945677788",
  "contact_avatar_url": "https://...",
  "source": "whatsapp",
  "service": "Implante",
  "observation": "Cliente perguntou preco e demonstrou interesse",
  "tags": ["preco", "interesse alto"],
  "metadata": {
    "origem": "n8n"
  }
}`)}</pre>
          <pre class="docs-code">${escapeHtml(`PATCH /api/v1/cards/123/stage
{
  "stage_key": "agendamento"
}`)}</pre>
        </section>

        <section class="docs-section">
          <h3>Decisao do agente por conversa</h3>
          <p>Use quando o n8n/IA ja sabe o ID da conversa do Chatwoot e quer atualizar o card com a decisao.</p>
          <pre class="docs-code">${escapeHtml(`POST /api/v1/conversations/23/card
{
  "account_id": ${accountId},
  "stage_key": "agendamento",
  "contact_name": "Lucas Moreira",
  "contact_phone": "+5511945677788",
  "service": "Implante",
  "observation": "Agendou avaliacao para quinta as 14h",
  "tags": ["agendado", "implante"]
}`)}</pre>
        </section>

        <section class="docs-section">
          <h3>Follow-up</h3>
          <div class="route-list">
            <div class="route-row"><span class="method">GET</span><code>/api/v1/follow-ups/due?account_id=${escapeHtml(accountId)}&limit=50</code></div>
            <div class="route-row"><span class="method">POST</span><code>/api/v1/follow-ups/:cardId/register</code></div>
          </div>
          <p>Fluxo no n8n: buscar pendentes, enviar mensagem no Chatwoot, registrar tentativa. Depois do limite configurado, o card vai para perdido.</p>
        </section>

        <section class="docs-section">
          <h3>Webhook Chatwoot</h3>
          <p>Configure no Chatwoot para eventos de mensagem recebida.</p>
          <pre class="docs-code">${escapeHtml(`POST /webhooks/chatwoot?secret=CHATWOOT_WEBHOOK_SECRET
Header alternativo:
X-Kanban-Webhook-Secret: CHATWOOT_WEBHOOK_SECRET`)}</pre>
        </section>

        <section class="docs-section">
          <h3>Modelo rapido para HTTP Request no n8n</h3>
          <pre class="docs-code">${escapeHtml(`Method: POST
URL: ${baseUrl}/api/v1/conversations/{{$json.id_conversa}}/card
Send Body: JSON
Body:
{
  "account_id": ${accountId},
  "stage_key": "qualificado",
  "contact_name": "={{ $json.nome }}",
  "contact_phone": "={{ $json.telefone }}",
  "service": "={{ $json.servico }}",
  "observation": "={{ $json.observacao }}",
  "tags": ["n8n", "ia"]
}`)}</pre>
        </section>
      </div>
    `,
    async (root) => {
      const input = root.querySelector("#api-key-value");
      const hint = root.querySelector("#api-key-hint");
      const toggle = root.querySelector('[data-action="toggle-api-key"]');
      const copy = root.querySelector('[data-action="copy-api-key"]');
      const followUpForm = root.querySelector("#followup-settings-form");
      const followUpTestForm = root.querySelector("#followup-test-form");
      let revealed = false;
      let key = "";

      function renderKey() {
        input.value = revealed ? key : key.replace(/.(?=.{6})/g, "•");
        toggle.textContent = revealed ? "Ocultar" : "Revelar";
      }

      try {
        const settings = await loadApiSettings();
        key = settings.apiKey || "";
        hint.textContent = `Account ID: ${settings.accountId || accountId} · Header: Authorization: Bearer <API_KEY>`;
        followUpForm.elements.follow_up_after_hours.value = settings.followUp?.followUpAfterHours ?? 24;
        followUpForm.elements.lost_after_attempts.value = settings.followUp?.lostAfterAttempts ?? 2;
        renderKey();
      } catch (error) {
        input.value = "Nao consegui carregar a API key";
        hint.textContent = error.message;
      }

      toggle.addEventListener("click", () => {
        revealed = !revealed;
        renderKey();
      });

      copy.addEventListener("click", async () => {
        if (!key) return;
        await navigator.clipboard.writeText(key);
        setStatus("API key copiada.");
      });

      followUpForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = formObject(event.currentTarget);
        try {
          const saved = await api("/settings/follow-up", {
            method: "PATCH",
            body: JSON.stringify({
              account_id: Number(accountId),
              follow_up_after_hours: Number(data.follow_up_after_hours),
              lost_after_attempts: Number(data.lost_after_attempts),
            }),
          });
          apiSettings = { ...(apiSettings || {}), followUp: saved };
          setStatus("Configuração de follow-up salva.");
        } catch (error) {
          setStatus(`Nao consegui salvar follow-up: ${error.message}`);
        }
      });

      followUpTestForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = formObject(event.currentTarget);
        if (!data.card_id) {
          setStatus("Informe o ID do card para testar.");
          return;
        }
        try {
          await api(`/follow-ups/${encodeURIComponent(data.card_id)}/schedule`, {
            method: "POST",
            body: JSON.stringify({ minutes: Number(data.minutes || 1) }),
          });
          setStatus(`Teste agendado. O card ${data.card_id} deve aparecer em pendentes em ${data.minutes || 1} minuto(s).`);
        } catch (error) {
          setStatus(`Nao consegui agendar teste: ${error.message}`);
        }
      });
    },
  );
}

function openFollowUpModal() {
  const baseUrl = window.location.origin;

  openModal(
    "Configuração de follow-up",
    `
      <div class="docs">
        <section class="docs-section followup-panel">
          <h3>Regras automáticas</h3>
          <p>Controle quando uma conversa entra na fila de follow-up e quantas tentativas acontecem antes de ir para perdido.</p>
          <form class="settings-form" id="followup-settings-form">
            <label>
              <span>Horas até precisar de follow-up</span>
              <input name="follow_up_after_hours" type="number" min="0.01" max="720" step="0.01" placeholder="24" />
            </label>
            <label>
              <span>Tentativas até mover para perdido</span>
              <input name="lost_after_attempts" type="number" min="1" max="20" step="1" placeholder="2" />
            </label>
            <button class="primary-btn" type="submit">Salvar</button>
          </form>
        </section>

        <section class="docs-section followup-panel">
          <h3>Teste rápido</h3>
          <p>Use para testar antes de esperar 24 horas. Informe o ID do card e agende ele para ficar pendente em alguns minutos.</p>
          <form class="settings-form" id="followup-test-form">
            <label>
              <span>ID do card</span>
              <input name="card_id" inputmode="numeric" placeholder="Ex: 28" />
            </label>
            <label>
              <span>Daqui quantos minutos?</span>
              <input name="minutes" type="number" min="0" max="43200" step="1" value="1" />
            </label>
            <button class="secondary-btn" type="submit">Agendar teste</button>
          </form>
        </section>

        <section class="docs-section">
          <h3>Como o n8n consulta pendentes</h3>
          <pre class="docs-code">${escapeHtml(`GET ${baseUrl}/api/v1/follow-ups/due?account_id=${accountId}&limit=50
Authorization: Bearer <KANBAN_API_KEY>

Depois de enviar a mensagem:
POST ${baseUrl}/api/v1/follow-ups/{cardId}/register`)}</pre>
        </section>
      </div>
    `,
    async (root) => {
      const followUpForm = root.querySelector("#followup-settings-form");
      const followUpTestForm = root.querySelector("#followup-test-form");

      try {
        apiSettings = null;
        const settings = await loadApiSettings();
        followUpForm.elements.follow_up_after_hours.value = settings.followUp?.followUpAfterHours ?? 24;
        followUpForm.elements.lost_after_attempts.value = settings.followUp?.lostAfterAttempts ?? 2;
      } catch (error) {
        setStatus(`Nao consegui carregar follow-up: ${error.message}`);
      }

      followUpForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = formObject(event.currentTarget);
        try {
          const saved = await api("/settings/follow-up", {
            method: "PATCH",
            body: JSON.stringify({
              account_id: Number(accountId),
              follow_up_after_hours: Number(data.follow_up_after_hours),
              lost_after_attempts: Number(data.lost_after_attempts),
            }),
          });
          apiSettings = { ...(apiSettings || {}), followUp: saved };
          setStatus("Configuração de follow-up salva.");
        } catch (error) {
          setStatus(`Nao consegui salvar follow-up: ${error.message}`);
        }
      });

      followUpTestForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = formObject(event.currentTarget);
        if (!data.card_id) {
          setStatus("Informe o ID do card para testar.");
          return;
        }
        try {
          await api(`/follow-ups/${encodeURIComponent(data.card_id)}/schedule`, {
            method: "POST",
            body: JSON.stringify({ minutes: Number(data.minutes || 1) }),
          });
          setStatus(`Teste agendado para o card ${data.card_id}.`);
        } catch (error) {
          setStatus(`Nao consegui agendar teste: ${error.message}`);
        }
      });
    },
  );
}

function moveCardLocally(cardId, stageKey) {
  let movedCard = null;

  for (const stage of boardData.stages) {
    const index = (stage.cards || []).findIndex((card) => String(card.id) === String(cardId));
    if (index >= 0) {
      movedCard = stage.cards.splice(index, 1)[0];
      break;
    }
  }

  const target = boardData.stages.find((stage) => stage.key === stageKey);
  if (movedCard && target) {
    movedCard.stageKey = stageKey;
    const stageId = target.id || movedCard.stageId;
    movedCard.stageId = String(stageId);
    target.cards.unshift(movedCard);
    animateCard(cardId);
  }
}

async function loadMoreCards(stageKey) {
  const stage = (boardData?.stages || []).find((item) => item.key === stageKey);
  if (!stage?.page?.nextCursor || loadingStageKey) return;

  loadingStageKey = stageKey;
  render();

  try {
    const params = new URLSearchParams({
      account_id: accountId,
      stage_key: stageKey,
      limit: String(stage.page.limit || cardsPageLimit),
      cursor: stage.page.nextCursor,
    });
    const page = await api(`/cards?${params.toString()}`);
    const existing = new Set((stage.cards || []).map((card) => String(card.id)));
    const incoming = (page.cards || []).filter((card) => !existing.has(String(card.id)));
    stage.cards = [...(stage.cards || []), ...incoming];
    stage.page = {
      limit: page.limit || stage.page.limit || cardsPageLimit,
      nextCursor: page.nextCursor || null,
      hasMore: Boolean(page.nextCursor),
    };
    setStatus(incoming.length ? `${incoming.length} cards carregados.` : "Nenhum card novo para carregar.", 1600);
  } catch (error) {
    setStatus(`Nao consegui carregar mais cards: ${error.message}`, 5000);
  } finally {
    loadingStageKey = "";
    render();
  }
}

async function searchCardsOnServer(term) {
  const requestId = ++searchRequestId;
  const normalized = String(term || "").trim().toLowerCase();
  searchTerm = normalized;

  if (!normalized) {
    await loadBoard({ silent: true });
    return;
  }

  setStatus("Buscando no servidor...", 0);

  try {
    if (!boardData) {
      boardData = await api(`/boards?account_id=${encodeURIComponent(accountId)}&limit=${cardsPageLimit}`);
    }

    const params = new URLSearchParams({
      account_id: accountId,
      q: normalized,
      limit: "100",
    });
    if (selectedAgent) params.set("agent", selectedAgent);
    if (selectedInbox) params.set("inbox", selectedInbox);

    const page = await api(`/cards?${params.toString()}`);
    if (requestId !== searchRequestId) return;

    const stages = (boardData.stages || []).map((stage) => ({
      ...stage,
      cards: [],
      totalCards: 0,
      page: { limit: 100, nextCursor: null, hasMore: false },
    }));
    const byStage = new Map(stages.map((stage) => [stage.key, stage]));

    for (const card of page.cards || []) {
      const stage = byStage.get(card.stageKey);
      if (!stage) continue;
      stage.cards.push(card);
      stage.totalCards += 1;
    }

    boardData = {
      ...boardData,
      stages,
    };
    setStatus((page.cards || []).length ? "" : "Nenhum card encontrado.", 2200);
    render();
  } catch (error) {
    if (requestId !== searchRequestId) return;
    setStatus(`Nao consegui buscar: ${error.message}`, 5000);
  }
}

function bindBoardEvents() {
  document.querySelectorAll(".card").forEach((cardEl) => {
    cardEl.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", cardEl.dataset.cardId);
      event.dataTransfer.effectAllowed = "move";
    });

    cardEl.addEventListener("click", (event) => {
      if (event.target.closest("button,a,input,select,textarea")) return;
      const card = findCard(cardEl.dataset.cardId);
      openConversation(card);
    });
  });

  document.querySelectorAll(".column").forEach((columnEl) => {
    columnEl.addEventListener("dragover", (event) => {
      event.preventDefault();
      columnEl.classList.add("drag-over");
    });

    columnEl.addEventListener("dragleave", () => {
      columnEl.classList.remove("drag-over");
    });

    columnEl.addEventListener("drop", async (event) => {
      event.preventDefault();
      columnEl.classList.remove("drag-over");
      const cardId = event.dataTransfer.getData("text/plain");
      const stageKey = columnEl.dataset.stageKey;
      if (!cardId || !stageKey) return;

      moveCardLocally(cardId, stageKey);
      render();

      try {
        await api(`/cards/${encodeURIComponent(cardId)}/stage`, {
          method: "PATCH",
          body: JSON.stringify({ stage_key: stageKey }),
        });
        setStatus("Card atualizado.");
      } catch (error) {
        setStatus(`Nao consegui salvar a mudanca: ${error.message}`);
        await loadBoard();
      }
    });
  });
}

async function loadBoard(options = {}) {
  if (!options.silent) setStatus("Carregando Kanban...", 0);

  try {
    boardData = await api(`/boards?account_id=${encodeURIComponent(accountId)}&limit=${cardsPageLimit}`);
    if (!options.silent) setStatus("");
    else if (options.reason) setStatus(options.reason, 1200);
  } catch (error) {
    boardData = sampleData;
    setStatus(`Preview local ativo. API indisponivel: ${error.message}`, 7000);
  }

  render();
}

function startPollingFallback() {
  window.clearInterval(pollingTimer);
  pollingTimer = window.setInterval(() => loadBoard({ silent: true }), 10000);
}

function connectRealtime() {
  if (!window.EventSource) {
    startPollingFallback();
    return;
  }

  if (realtimeSource) realtimeSource.close();
  window.clearTimeout(realtimeRetry);

  const params = new URLSearchParams({ account_id: accountId });
  if (apiKey) params.set("apiKey", apiKey);
  realtimeSource = new EventSource(`${apiBaseUrl}/events?${params.toString()}`);

  realtimeSource.addEventListener("ready", () => {
    window.clearInterval(pollingTimer);
    setStatus("Tempo real conectado.", 1800);
  });

  ["card.created", "card.updated", "card.moved", "card.deleted"].forEach((eventName) => {
    realtimeSource.addEventListener(eventName, (event) => handleRealtimeCardEvent(event, eventName));
  });

  ["stage.created", "stage.updated", "stage.deleted"].forEach((eventName) => {
    realtimeSource.addEventListener(eventName, () => {
      scheduleBoardReload("Funil atualizado em tempo real.");
    });
  });

  realtimeSource.onerror = () => {
    realtimeSource?.close();
    realtimeSource = null;
    startPollingFallback();
    realtimeRetry = window.setTimeout(connectRealtime, 5000);
  };
}

window.KanbanUI = {
  closeModal,
  filterAgent: () => openFilterModal("agent"),
  filterInbox: () => openFilterModal("inbox"),
  deleteCard,
  editCard: openEditCardModal,
  openCard: (stageKey = "") => openCardModal(stageKey || boardData?.stages?.[0]?.key),
  openDocs: openDocsModal,
  openFollowUp: openFollowUpModal,
  openFunnel: openFunnelManager,
  openStage: (stageId = "") => {
    const stage = (boardData?.stages || []).find((item) => String(item.id) === String(stageId));
    openStageModal(stage || null);
  },
  reload: loadBoard,
};
document.documentElement.dataset.kanbanReady = "true";

boardEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  if (action === "add-card") openCardModal(button.dataset.stageKey);
  if (action === "edit-card") openEditCardModal(button.dataset.cardId);
  if (action === "delete-card") deleteCard(button.dataset.cardId);
  if (action === "load-more") loadMoreCards(button.dataset.stageKey);
  if (action === "edit-stage") {
    const stage = (boardData?.stages || []).find((item) => String(item.id) === String(button.dataset.stageId));
    if (stage) openStageModal(stage);
  }
});

modalBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  if (action === "cancel-modal") closeModal();
  if (action === "new-stage") openStageModal();
  if (action === "add-card") openCardModal(button.dataset.stageKey);
  if (action === "edit-stage") {
    const stage = (boardData?.stages || []).find((item) => String(item.id) === String(button.dataset.stageId));
    if (stage) openStageModal(stage);
  }
});

modalClose.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", (event) => {
  if (event.target === modalBackdrop) closeModal();
});

searchEl.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  const term = searchEl.value.trim();
  searchTimer = window.setTimeout(() => {
    searchCardsOnServer(term);
  }, 250);
});

refreshEl.addEventListener("click", loadBoard);
addCardBtn.addEventListener("click", () => openCardModal(boardData?.stages?.[0]?.key));
settingsBtn.addEventListener("click", openFunnelManager);
agentFilterBtn.addEventListener("click", () => openFilterModal("agent"));
inboxFilterBtn.addEventListener("click", () => openFilterModal("inbox"));
followupBtn?.addEventListener("click", openFollowUpModal);
docsBtn.addEventListener("click", openDocsModal);

loadBoard().then(connectRealtime);
