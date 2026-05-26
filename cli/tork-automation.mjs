#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
import os from "node:os";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const defaultManifestPath = path.join(repoRoot, "manifests", "tork-stack.local.json");
const defaultInstallDir = "/opt/tork-automation";
const cliVersion = "0.2.0";
const defaultClientId = "principal";
const defaultBaseDomain = "sistemasautomacao.store";

function parseArgs(argv) {
  const args = { command: "", flags: {}, install: [] };
  const rest = [...argv];
  args.command = rest.shift() || "menu";

  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      args.install.push(item);
      continue;
    }

    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      args.flags[key] = true;
    } else {
      args.flags[key] = next;
      index += 1;
    }
  }

  return args;
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function slugifyClientId(value, fallback = defaultClientId) {
  const slug = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function composeProjectNameForClient(clientId) {
  return `tork-${slugifyClientId(clientId)}`.slice(0, 63);
}

function networkNameForClient(clientId) {
  return `tork-${slugifyClientId(clientId)}-infra`.slice(0, 63);
}

function volumePrefixForClient(clientId) {
  return `tork_${slugifyClientId(clientId).replace(/-/g, "_")}`;
}

function defaultInstallDirForClient(clientId, baseDir = defaultInstallDir) {
  const slug = slugifyClientId(clientId);
  if (slug === defaultClientId) return baseDir;
  return path.join(baseDir, "clients", slug);
}

function defaultKanbanPortForClient(clientId, fallback = 8090) {
  const slug = slugifyClientId(clientId);
  if (slug === defaultClientId) return fallback;
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) % 800;
  return 8100 + hash;
}

function boolFlag(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (value === true || value === false) return value;
  if (["0", "false", "no", "nao", "não", "off"].includes(String(value).toLowerCase())) return false;
  return true;
}

function normalizeBaseDomain(value, fallback = defaultBaseDomain) {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+|\.+$/g, "") || fallback;
}

function serviceDomain(service, clientId, baseDomain) {
  const slug = slugifyClientId(clientId);
  const prefix = slug === defaultClientId ? service : `${service}-${slug}`;
  return `${prefix}.${normalizeBaseDomain(baseDomain)}`;
}

function kanbanPortsBlock(port, expose) {
  if (!expose) return "";
  return `ports:\n      - "${port}:80"`;
}

function requireSafeKey(key) {
  const normalized = String(key || "").trim();
  if (!/^[A-Za-z0-9._:-]{6,160}$/.test(normalized)) {
    throw new Error("Chave invalida. Use apenas letras, numeros, ponto, hifen, dois-pontos ou underline.");
  }
  return normalized;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value, mode = 0o600) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", { mode });
}

async function machineId() {
  const candidates = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
  for (const file of candidates) {
    try {
      const value = (await fs.readFile(file, "utf8")).trim();
      if (value) return value;
    } catch {
      // Ignore absent machine-id files on local dev systems.
    }
  }
  return "";
}

async function installationIdentity(installDir) {
  return {
    hostname: os.hostname(),
    machineId: await machineId(),
    installDir: path.resolve(String(installDir || defaultInstallDir)),
  };
}

async function loadManifest({ manifestPath, centralUrl, key, installation }) {
  if (centralUrl) {
    requireSafeKey(key);
    const url = new URL("/api/installations/manifest", centralUrl);
    const response = await fetch(url, {
      method: installation ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "User-Agent": `tork-automation-cli/${cliVersion}`,
        ...(installation ? { "Content-Type": "application/json" } : {}),
      },
      body: installation ? JSON.stringify(installation) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Central recusou manifesto: HTTP ${response.status}`);
    }
    return payload.data || payload;
  }

  return readJson(manifestPath || defaultManifestPath);
}

function renderTemplate(template, values) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Valor ausente para template: ${key}`);
    return String(values[key]);
  });
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readState(installDir) {
  const statePath = path.join(installDir, ".tork-state.json");
  if (!(await fileExists(statePath))) return {};
  return readJson(statePath);
}

async function writeState(installDir, patch) {
  await ensureDir(installDir);
  const statePath = path.join(installDir, ".tork-state.json");
  const current = await readState(installDir);
  await writeJson(statePath, {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    ...current,
    ...patch,
  });
}

function parseEnv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    values[line.slice(0, index)] = line.slice(index + 1);
  }
  return values;
}

async function readEnv(installDir) {
  const envPath = path.join(installDir, ".env");
  if (!(await fileExists(envPath))) return {};
  return parseEnv(await fs.readFile(envPath, "utf8"));
}

async function writeIfMissing(filePath, content, mode = 0o600) {
  if (await fileExists(filePath)) return false;
  await fs.writeFile(filePath, content, { mode });
  return true;
}

function baseValues(manifest, answers = {}) {
  const defaults = manifest.defaults || {};
  const images = manifest.images || {};
  const manifestClientId = manifest.license?.mode === "central" ? manifest.license.customerId : defaults.clientId || defaultClientId;
  const clientId = slugifyClientId(answers.clientId || manifestClientId);
  const clientName = answers.clientName || defaults.clientName || clientId;
  const baseDomain = normalizeBaseDomain(answers.baseDomain || defaults.baseDomain || defaultBaseDomain);
  const projectName = answers.projectName || defaults.projectName || composeProjectNameForClient(clientId);
  const volumePrefix = volumePrefixForClient(clientId);
  const defaultNetwork = clientId === defaultClientId
    ? defaults.network || networkNameForClient(clientId)
    : networkNameForClient(clientId);
  const kanbanApiKey = answers.kanbanApiKey || randomSecret(32);
  const chatwootWebhookSecret = answers.chatwootWebhookSecret || randomSecret(24);
  const chatwootStorageVolume = answers.chatwootStorageVolume || `${volumePrefix}_chatwoot-storage`;
  const defaultKanbanHttpPort = defaults.kanbanHttpPort || 8090;
  const kanbanHttpPort = answers.kanbanHttpPort || defaultKanbanPortForClient(clientId, defaultKanbanHttpPort);
  const sharedProxy = boolFlag(answers.sharedProxy, false);
  const exposeKanbanPort = boolFlag(answers.exposeKanbanPort, !sharedProxy);

  return {
    CLIENT_ID: clientId,
    CLIENT_NAME: clientName,
    BASE_DOMAIN: baseDomain,
    PROJECT_NAME: projectName,
    NETWORK: answers.network || defaultNetwork,
    KANBAN_DOMAIN: answers.kanbanDomain || serviceDomain("kanban", clientId, baseDomain),
    CHATWOOT_DOMAIN: answers.chatwootDomain || serviceDomain("chatwoot", clientId, baseDomain),
    N8N_DOMAIN: answers.n8nDomain || serviceDomain("n8n", clientId, baseDomain),
    KANBAN_HTTP_PORT: kanbanHttpPort,
    KANBAN_PORTS_BLOCK: kanbanPortsBlock(kanbanHttpPort, exposeKanbanPort),
    SHARED_PROXY: sharedProxy ? "1" : "0",
    EXPOSE_KANBAN_PORT: exposeKanbanPort ? "1" : "0",
    PROXY_HTTP_PORT: answers.proxyHttpPort || defaults.proxyHttpPort || 80,
    PROXY_HTTPS_PORT: answers.proxyHttpsPort || defaults.proxyHttpsPort || 443,
    PROXY_ADMIN_PORT: answers.proxyAdminPort || defaults.proxyAdminPort || 81,
    KANBAN_BACKEND_IMAGE: images.kanbanBackend,
    KANBAN_FRONTEND_IMAGE: images.kanbanFrontend,
    CHATWOOT_IMAGE: images.chatwoot,
    CHATWOOT_POSTGRES_IMAGE: images.chatwootPostgres || images.postgres,
    N8N_IMAGE: images.n8n,
    POSTGRES_IMAGE: images.postgres,
    REDIS_IMAGE: images.redis,
    PROXY_IMAGE: images.proxy,
    KANBAN_POSTGRES_DB: "kanban",
    KANBAN_POSTGRES_USER: "kanban",
    KANBAN_POSTGRES_PASSWORD: answers.kanbanPostgresPassword || randomSecret(24),
    KANBAN_API_KEY: kanbanApiKey,
    CHATWOOT_API_TOKEN: answers.chatwootApiToken || "",
    CHATWOOT_DATABASE_URL: answers.chatwootDatabaseUrl || "",
    CHATWOOT_STORAGE_VOLUME: chatwootStorageVolume,
    CHATWOOT_WEBHOOK_SECRET: chatwootWebhookSecret,
    CHATWOOT_ASSIGNEE_SYNC_SECONDS: answers.chatwootAssigneeSyncSeconds || 5,
    DEFAULT_ACCOUNT_ID: answers.defaultAccountId || 1,
    DEFAULT_BOARD_NAME: answers.defaultBoardName || "Atendimento IA",
    FOLLOW_UP_AFTER_HOURS: answers.followUpAfterHours || 24,
    LOST_AFTER_ATTEMPTS: answers.lostAfterAttempts || 2,
    MAX_JSON_BODY_BYTES: answers.maxJsonBodyBytes || 262144,
    RATE_LIMIT_WINDOW_MS: answers.rateLimitWindowMs || 60000,
    RATE_LIMIT_MAX_REQUESTS: answers.rateLimitMaxRequests || 600,
    CORS_ORIGIN: answers.corsOrigin || "*",
    CHATWOOT_POSTGRES_DB: "chatwoot",
    CHATWOOT_POSTGRES_USER: "chatwoot",
    CHATWOOT_POSTGRES_PASSWORD: answers.chatwootPostgresPassword || randomSecret(24),
    CHATWOOT_SECRET_KEY_BASE: answers.chatwootSecretKeyBase || randomSecret(64),
    N8N_POSTGRES_DB: "n8n",
    N8N_POSTGRES_USER: "n8n",
    N8N_POSTGRES_PASSWORD: answers.n8nPostgresPassword || randomSecret(24),
    N8N_ENCRYPTION_KEY: answers.n8nEncryptionKey || randomSecret(32),
  };
}

function mergeManifestImages(values, manifest) {
  const images = manifest.images || {};
  return {
    ...values,
    KANBAN_BACKEND_IMAGE: images.kanbanBackend || values.KANBAN_BACKEND_IMAGE,
    KANBAN_FRONTEND_IMAGE: images.kanbanFrontend || values.KANBAN_FRONTEND_IMAGE,
    CHATWOOT_IMAGE: images.chatwoot || values.CHATWOOT_IMAGE,
    CHATWOOT_POSTGRES_IMAGE: images.chatwootPostgres || values.CHATWOOT_POSTGRES_IMAGE || values.POSTGRES_IMAGE,
    N8N_IMAGE: images.n8n || values.N8N_IMAGE,
    POSTGRES_IMAGE: images.postgres || values.POSTGRES_IMAGE,
    REDIS_IMAGE: images.redis || values.REDIS_IMAGE,
    PROXY_IMAGE: images.proxy || values.PROXY_IMAGE,
  };
}

async function collectAnswers(manifest, flags) {
  const defaults = manifest.defaults || {};
  const manifestClientId = manifest.license?.mode === "central" ? manifest.license.customerId : defaults.clientId || defaultClientId;
  const clientId = slugifyClientId(flags.clientId || manifestClientId);
  const clientName = flags.clientName || defaults.clientName || clientId;
  const baseDomain = normalizeBaseDomain(flags.baseDomain || defaults.baseDomain || defaultBaseDomain);
  const baseInstallDir = flags.baseInstallDir || defaults.installDir || defaultInstallDir;
  const defaultNetwork = clientId === defaultClientId
    ? defaults.network || networkNameForClient(clientId)
    : networkNameForClient(clientId);
  const defaultKanbanHttpPort = clientId === defaultClientId
    ? defaults.kanbanHttpPort || 8090
    : defaultKanbanPortForClient(clientId, defaults.kanbanHttpPort || 8090);
  const nonInteractive = Boolean(flags.yes || flags.nonInteractive);
  const answers = {
    clientId,
    clientName,
    baseDomain,
    projectName: flags.projectName || defaults.projectName || composeProjectNameForClient(clientId),
    network: flags.network || defaultNetwork,
    installDir: flags.installDir || defaultInstallDirForClient(clientId, baseInstallDir),
    kanbanDomain: flags.kanbanDomain || serviceDomain("kanban", clientId, baseDomain),
    chatwootDomain: flags.chatwootDomain || serviceDomain("chatwoot", clientId, baseDomain),
    n8nDomain: flags.n8nDomain || serviceDomain("n8n", clientId, baseDomain),
    kanbanHttpPort: flags.kanbanHttpPort || defaultKanbanHttpPort,
    sharedProxy: boolFlag(flags.sharedProxy, false),
    exposeKanbanPort: boolFlag(flags.exposeKanbanPort, !boolFlag(flags.sharedProxy, false) && !boolFlag(flags.noExposePorts, false)),
  };

  if (nonInteractive) return answers;

  const rl = await createPromptSession();
  try {
    answers.clientName = await rl.question(`Nome do cliente [${answers.clientName}]: `) || answers.clientName;
    answers.clientId = slugifyClientId(await rl.question(`ID do cliente [${answers.clientId}]: `) || answers.clientId);
    answers.projectName = await rl.question(`Projeto Docker Compose [${answers.projectName}]: `) || answers.projectName;
    answers.network = await rl.question(`Rede Docker [${answers.network}]: `) || answers.network;
    answers.installDir = await rl.question(`Diretorio de instalacao [${answers.installDir}]: `) || answers.installDir;
    answers.kanbanDomain = await rl.question(`Dominio do Kanban [${answers.kanbanDomain}]: `) || answers.kanbanDomain;
    answers.chatwootDomain = await rl.question(`Dominio do Chatwoot [${answers.chatwootDomain}]: `) || answers.chatwootDomain;
    answers.n8nDomain = await rl.question(`Dominio do n8n [${answers.n8nDomain}]: `) || answers.n8nDomain;
    answers.kanbanHttpPort = await rl.question(`Porta HTTP do Kanban [${answers.kanbanHttpPort}]: `) || answers.kanbanHttpPort;
  } finally {
    rl.close();
  }

  return answers;
}

function selectedStacks(flags, installArgs) {
  if (installArgs.length) return installArgs;
  if (flags.stack) return String(flags.stack).split(",").map((item) => item.trim()).filter(Boolean);
  if (flags.full) return ["proxy", "chatwoot", "n8n", "kanban"];
  return ["kanban"];
}

const useColor = Boolean(output.isTTY);
const color = {
  reset: useColor ? "\u001b[0m" : "",
  bold: useColor ? "\u001b[1m" : "",
  dim: useColor ? "\u001b[2m" : "",
  cyan: useColor ? "\u001b[36m" : "",
  green: useColor ? "\u001b[32m" : "",
  yellow: useColor ? "\u001b[33m" : "",
  blue: useColor ? "\u001b[34m" : "",
  magenta: useColor ? "\u001b[35m" : "",
};

function paint(value, style) {
  return `${style}${value}${color.reset}`;
}

function panel(title, rows = []) {
  const cleanRows = rows.map((row) => String(row));
  const width = Math.max(title.length + 4, ...cleanRows.map((row) => row.length + 4), 48);
  const line = `+${"-".repeat(width - 2)}+`;
  console.log("");
  console.log(paint(line, color.cyan));
  console.log(paint(`| ${title.padEnd(width - 4)} |`, color.cyan + color.bold));
  console.log(paint(line, color.cyan));
  for (const row of cleanRows) console.log(`| ${row.padEnd(width - 4)} |`);
  console.log(paint(line, color.cyan));
}

function banner(subtitle = "CLI para automacao de VPS") {
  const art = [
    " _______  ___   ____   _  __",
    "|_   _|/ _ \\ |  _ \\ | |/ /",
    "  | | | | | || |_) || ' / ",
    "  | | | |_| ||  _ < | . \\ ",
    "  |_|  \\___/ |_| \\_\\|_|\\_\\",
  ];
  console.log("");
  for (const line of art) console.log(paint(line, color.cyan + color.bold));
  console.log(paint(`Tork Automation ${cliVersion}`, color.magenta + color.bold));
  console.log(paint(subtitle, color.blue));
}

function section(title) {
  console.log("");
  console.log(paint(`-- ${title}`, color.blue + color.bold));
}

async function createPromptSession() {
  if (input.isTTY) {
    const rl = readline.createInterface({ input, output });
    return {
      question: (prompt) => rl.question(prompt),
      close: () => rl.close(),
    };
  }

  const content = await new Promise((resolve) => {
    let data = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      data += chunk;
    });
    input.on("end", () => resolve(data));
    input.resume();
  });
  const lines = String(content).split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();

  return {
    async question(prompt) {
      output.write(prompt);
      const value = lines.length ? lines.shift() : "";
      output.write(`${value}\n`);
      return value;
    },
    close() {},
  };
}

async function askValue(rl, label, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await rl.question(`${paint("?", color.green)} ${label}${suffix}: `);
  return answer.trim() || defaultValue;
}

async function askChoice(rl, label, choices, defaultKey = choices[0]?.key) {
  for (const choice of choices) {
    const marker = choice.key === defaultKey ? ">" : " ";
    const key = choice.key.padStart(2, " ");
    const line = `${marker} ${key}. ${choice.label}`;
    console.log(choice.key === defaultKey ? paint(line, color.green) : line);
  }
  const answer = await askValue(rl, label, defaultKey);
  const selected = choices.find((choice) => choice.key === answer);
  if (!selected) {
    console.log(paint(`Opcao invalida, usando ${defaultKey}.`, color.yellow));
    return choices.find((choice) => choice.key === defaultKey) || choices[0];
  }
  return selected;
}

function stackPreset(choice) {
  if (choice === "kanban") return { flags: {}, install: ["kanban"], label: "Kanban" };
  if (choice === "chatwoot-kanban") return { flags: {}, install: ["chatwoot", "kanban"], label: "Chatwoot + Kanban" };
  if (choice === "client-full") return { flags: {}, install: ["chatwoot", "n8n", "kanban"], label: "Cliente completo sem proxy" };
  if (choice === "n8n") return { flags: {}, install: ["n8n"], label: "n8n" };
  if (choice === "proxy") return { flags: {}, install: ["proxy"], label: "Nginx Proxy Manager" };
  return { flags: { full: true }, install: [], label: "Stack completa" };
}

function selectedStackNamesFromPreset(preset) {
  if (preset.flags.full) return ["proxy", "chatwoot", "n8n", "kanban"];
  return preset.install;
}

async function renderStack({ manifest, stacks, values, installDir }) {
  const composeFiles = [];
  await ensureDir(installDir);
  await ensureDir(path.join(installDir, "generated"));

  for (const stackName of stacks) {
    const stack = manifest.stacks?.[stackName];
    if (!stack) throw new Error(`Stack desconhecida no manifesto: ${stackName}`);

    const templatePath = path.join(repoRoot, stack.composeTemplate);
    const template = await fs.readFile(templatePath, "utf8");
    const rendered = renderTemplate(template, values);
    const outputPath = path.join(installDir, "generated", `${stackName}.compose.yml`);
    await fs.writeFile(outputPath, rendered, { mode: 0o600 });
    composeFiles.push(outputPath);
  }

  const envPath = path.join(installDir, ".env");
  await writeIfMissing(envPath, Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/\n/g, "")}`).join("\n") + "\n");

  const manifestPath = path.join(installDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

  return { composeFiles, envPath, manifestPath };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture || options.input ? "pipe" : "inherit",
    encoding: "utf8",
    input: options.input,
  });
  if (result.status !== 0) {
    const detail = options.capture && result.stderr ? `: ${result.stderr.trim()}` : "";
    throw new Error(`${command} ${args.join(" ")} falhou${detail}`);
  }
  return result.stdout || "";
}

function dockerComposeArgs(composeFiles, extraArgs, projectName) {
  return [
    ...(projectName ? ["--project-name", projectName] : []),
    ...composeFiles.flatMap((file) => ["-f", file]),
    ...extraArgs,
  ];
}

async function composeProjectNameForInstallDir(installDir) {
  const state = await readState(installDir);
  if (state.projectName) return state.projectName;
  const env = await readEnv(installDir);
  return env.PROJECT_NAME || "";
}

function ensureDockerNetwork(network, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] docker network create ${network}`);
    return;
  }
  const inspect = spawnSync("docker", ["network", "inspect", network], { stdio: "ignore" });
  if (inspect.status !== 0) {
    run("docker", ["network", "create", network]);
  }
}

function detectedProxyContainers() {
  const result = spawnSync("docker", ["ps", "--format", "{{.Names}}"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => /(^|[-_])(proxy|nginx-proxy-manager|npm)([-_]|$)/i.test(name));
}

function connectProxyContainers(network, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] conectar proxy existente na rede ${network}`);
    return;
  }
  const proxies = detectedProxyContainers();
  for (const container of proxies) {
    const result = spawnSync("docker", ["network", "connect", network, container], {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (result.status !== 0 && !String(result.stderr || "").includes("already exists")) {
      throw new Error(`docker network connect ${network} ${container} falhou: ${result.stderr.trim()}`);
    }
  }
  if (proxies.length) {
    console.log(`Proxy conectado na rede ${network}: ${proxies.join(", ")}`);
  } else {
    console.log(`Nenhum container de proxy encontrado para conectar na rede ${network}.`);
  }
}

function proxyRoutesForStacks(values, stacks) {
  const routes = [];
  if (stacks.includes("kanban")) {
    routes.push({
      domain: values.KANBAN_DOMAIN,
      target: `${values.CLIENT_ID}-kanban-frontend`,
      port: 80,
    });
  }
  if (stacks.includes("chatwoot")) {
    routes.push({
      domain: values.CHATWOOT_DOMAIN,
      target: `${values.CLIENT_ID}-chatwoot`,
      port: 3000,
    });
  }
  if (stacks.includes("n8n")) {
    routes.push({
      domain: values.N8N_DOMAIN,
      target: `${values.CLIENT_ID}-n8n`,
      port: 5678,
    });
  }
  return routes;
}

function chatwootEmbedAdvancedConfig(kanbanDomain) {
  const scriptUrl = `https://${kanbanDomain}/dashboard-script.js`;
  return [
    "# Tork Automation: Kanban embed no Chatwoot",
    'proxy_set_header Accept-Encoding "";',
    "proxy_hide_header Content-Security-Policy;",
    "proxy_hide_header Content-Security-Policy-Report-Only;",
    "sub_filter_once on;",
    "sub_filter_types text/html;",
    `sub_filter '</body>' '<script src=\"${scriptUrl}\" defer></script></body>';`,
  ].join("\n");
}

function npmProxyProvisionScript({ routes, useSsl = true }) {
  return `
import fs from "node:fs";
import Certificate from "/app/models/certificate.js";
import ProxyHost from "/app/models/proxy_host.js";
import User from "/app/models/user.js";
import internalCertificate from "/app/internal/certificate.js";
import internalNginx from "/app/internal/nginx.js";

const routes = ${JSON.stringify(routes, null, 2)};
const useSsl = ${JSON.stringify(Boolean(useSsl))};
const domains = routes.map((route) => route.domain).filter(Boolean);

function sqlDateFromEpoch(seconds) {
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function sameDomains(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

const user = await User.query()
  .where("is_deleted", 0)
  .andWhere("is_disabled", 0)
  .orderBy("id")
  .first();

if (!user?.email && useSsl) {
  throw new Error("NPM precisa de um usuario ativo com email para emitir SSL");
}

let certificate = null;
if (useSsl && domains.length) {
  const existingCerts = await Certificate.query().where("is_deleted", 0);
  certificate = existingCerts.find((row) => {
    return row.provider === "letsencrypt" && sameDomains(row.domain_names || [], domains);
  });

  if (!certificate || !fs.existsSync(\`\${internalCertificate.getLiveCertPath(certificate.id)}/fullchain.pem\`)) {
    certificate = await Certificate.query().insertAndFetch({
      owner_user_id: user.id,
      provider: "letsencrypt",
      nice_name: domains.join(", "),
      domain_names: domains,
      meta: {
        letsencrypt_agree: true,
        dns_challenge: false,
      },
    });

    try {
      await internalNginx.generateLetsEncryptRequestConfig(certificate);
      await internalNginx.reload();
      await internalCertificate.requestLetsEncryptSsl(certificate, user.email);
      await internalNginx.deleteLetsEncryptRequestConfig(certificate);
      await internalNginx.reload();

      const certInfo = await internalCertificate.getCertificateInfoFromFile(
        \`\${internalCertificate.getLiveCertPath(certificate.id)}/fullchain.pem\`,
      );

      certificate = await Certificate.query().patchAndFetchById(certificate.id, {
        expires_on: sqlDateFromEpoch(certInfo.dates.to),
        meta: {
          ...certificate.meta,
          letsencrypt_certificate: certInfo,
        },
      });
    } catch (error) {
      await internalNginx.deleteLetsEncryptRequestConfig(certificate).catch(() => {});
      await Certificate.query().patchAndFetchById(certificate.id, { is_deleted: 1 }).catch(() => {});
      await internalNginx.reload().catch(() => {});
      throw error;
    }
  }
}

const allHosts = await ProxyHost.query().where("is_deleted", 0);
const configured = [];

for (const route of routes) {
  const existing = allHosts.find((row) => {
    return Array.isArray(row.domain_names) && row.domain_names.includes(route.domain);
  });

  const payload = {
    owner_user_id: user?.id || 1,
    domain_names: [route.domain],
    forward_scheme: "http",
    forward_host: route.target,
    forward_port: route.port,
    access_list_id: 0,
    certificate_id: certificate?.id || existing?.certificate_id || 0,
    ssl_forced: Boolean(certificate),
    caching_enabled: false,
    block_exploits: true,
    advanced_config: route.advancedConfig || "",
    meta: {},
    allow_websocket_upgrade: true,
    http2_support: Boolean(certificate),
    enabled: true,
    locations: [],
    hsts_enabled: false,
    hsts_subdomains: false,
    trust_forwarded_proto: false,
  };

  const row = existing
    ? await ProxyHost.query().patchAndFetchById(existing.id, payload)
    : await ProxyHost.query().insertAndFetch(payload);

  const hydrated = await ProxyHost.query()
    .findById(row.id)
    .withGraphFetched("[certificate,access_list]");

  await internalNginx.configure(ProxyHost, "proxy_host", hydrated);
  configured.push({
    id: row.id,
    domain: route.domain,
    target: \`\${route.target}:\${route.port}\`,
    certificateId: certificate?.id || existing?.certificate_id || 0,
    embedded: Boolean(route.advancedConfig),
  });
}

await ProxyHost.knex().destroy();
console.log(JSON.stringify({ ok: true, certificateId: certificate?.id || null, configured }, null, 2));
`;
}

function printSharedProxyInstructions(values, stacks) {
  const routes = proxyRoutesForStacks(values, stacks);
  if (!routes.length) return;
  console.log("");
  console.log("Nginx Proxy Manager compartilhado:");
  console.log(`- Rede conectada: ${values.NETWORK}`);
  for (const route of routes) {
    console.log(`- ${route.domain} -> http://${route.target}:${route.port}`);
  }
}

async function composeFilesForInstallDir(installDir) {
  const generatedDir = path.join(installDir, "generated");
  return (await fs.readdir(generatedDir).catch(() => []))
    .filter((file) => file.endsWith(".compose.yml"))
    .sort()
    .map((file) => path.join(generatedDir, file));
}

function stackNamesFromComposeFiles(files) {
  return files.map((file) => path.basename(file).replace(/\.compose\.yml$/, ""));
}

async function copyIfExists(source, target) {
  if (!(await fileExists(source))) return false;
  await fs.cp(source, target, { recursive: true });
  return true;
}

async function replaceIfExists(source, target) {
  if (!(await fileExists(source))) return false;
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true });
  return true;
}

async function dumpPostgresData({ installDir, composeFiles, stagingDir, dryRun, projectName }) {
  const services = [
    { service: "kanban-postgres", user: "kanban", database: "kanban", file: "kanban.sql" },
    { service: "chatwoot-postgres", user: "chatwoot", database: "chatwoot", file: "chatwoot.sql" },
    { service: "n8n-postgres", user: "n8n", database: "n8n", file: "n8n.sql" },
  ];
  const dumpsDir = path.join(stagingDir, "postgres-dumps");
  await ensureDir(dumpsDir);

  for (const dump of services) {
    const target = path.join(dumpsDir, dump.file);
    const dockerArgs = [
      "compose",
      ...dockerComposeArgs(composeFiles, ["exec", "-T", dump.service, "pg_dump", "-U", dump.user, dump.database], projectName),
    ];
    if (dryRun) {
      console.log(`[dry-run] docker ${dockerArgs.join(" ")} > ${target}`);
      continue;
    }
    const sql = run("docker", dockerArgs, { capture: true });
    await fs.writeFile(target, sql, { mode: 0o600 });
  }
}

async function restorePostgresData({ composeFiles, extractedDir, dryRun, projectName }) {
  const services = [
    { service: "kanban-postgres", user: "kanban", database: "kanban", file: "kanban.sql" },
    { service: "chatwoot-postgres", user: "chatwoot", database: "chatwoot", file: "chatwoot.sql" },
    { service: "n8n-postgres", user: "n8n", database: "n8n", file: "n8n.sql" },
  ];

  for (const dump of services) {
    const source = path.join(extractedDir, "postgres-dumps", dump.file);
    if (!(await fileExists(source))) continue;
    const dockerArgs = [
      "compose",
      ...dockerComposeArgs(composeFiles, ["exec", "-T", dump.service, "psql", "-U", dump.user, "-d", dump.database], projectName),
    ];
    if (dryRun) {
      console.log(`[dry-run] docker ${dockerArgs.join(" ")} < ${source}`);
      continue;
    }
    run("docker", dockerArgs, { input: await fs.readFile(source, "utf8") });
  }
}

async function installCommand(args) {
  const key = args.flags.key || process.env.TORK_INSTALL_KEY || "LOCAL-DEV";
  const requestedInstallDir = path.resolve(String(args.flags.installDir || defaultInstallDir));
  const manifest = await loadManifest({
    manifestPath: args.flags.manifest,
    centralUrl: args.flags.centralUrl,
    key,
    installation: args.flags.centralUrl ? await installationIdentity(requestedInstallDir) : undefined,
  });
  const stacks = selectedStacks(args.flags, args.install);
  const answers = await collectAnswers(manifest, args.flags);
  const installDir = path.resolve(String(answers.installDir));
  const values = baseValues(manifest, answers);
  const rendered = await renderStack({ manifest, stacks, values, installDir });
  const projectName = values.PROJECT_NAME;

  console.log(`Manifesto: ${manifest.product} ${manifest.version}`);
  console.log(`Cliente: ${values.CLIENT_NAME} (${values.CLIENT_ID})`);
  console.log(`Projeto Docker: ${projectName}`);
  console.log(`Instalacao: ${installDir}`);
  console.log(`Stacks: ${stacks.join(", ")}`);
  console.log(`Arquivos:`);
  for (const file of rendered.composeFiles) console.log(`- ${file}`);

  const dryRun = Boolean(args.flags.dryRun);
  ensureDockerNetwork(values.NETWORK, dryRun);

  if (dryRun) {
    if (args.flags.connectProxy) connectProxyContainers(values.NETWORK, true);
    console.log(`[dry-run] docker compose ${dockerComposeArgs(rendered.composeFiles, ["up", "-d"], projectName).join(" ")}`);
    if (values.SHARED_PROXY === "1") printSharedProxyInstructions(values, stacks);
    await writeState(installDir, {
      installedAt: new Date().toISOString(),
      installDir,
      clientId: values.CLIENT_ID,
      clientName: values.CLIENT_NAME,
      projectName,
      network: values.NETWORK,
      sharedProxy: values.SHARED_PROXY === "1",
      exposeKanbanPort: values.EXPOSE_KANBAN_PORT === "1",
      manifestVersion: manifest.version,
      stacks,
      composeFiles: rendered.composeFiles,
      dryRun: true,
    });
    return;
  }

  if (args.flags.connectProxy) connectProxyContainers(values.NETWORK, false);
  run("docker", ["compose", ...dockerComposeArgs(rendered.composeFiles, ["up", "-d"], projectName)]);
  if (values.SHARED_PROXY === "1") printSharedProxyInstructions(values, stacks);
  await writeState(installDir, {
    installedAt: new Date().toISOString(),
    installDir,
    clientId: values.CLIENT_ID,
    clientName: values.CLIENT_NAME,
    projectName,
    network: values.NETWORK,
    sharedProxy: values.SHARED_PROXY === "1",
    exposeKanbanPort: values.EXPOSE_KANBAN_PORT === "1",
    manifestVersion: manifest.version,
    stacks,
    composeFiles: rendered.composeFiles,
    dryRun: false,
  });

  if (stacks.includes("chatwoot") && stacks.includes("kanban")) {
    console.log("");
    console.log(`Proximo passo: tork-automation embed-chatwoot --installDir ${installDir}`);
  }
}

async function embedChatwootCommand(args) {
  const installDir = path.resolve(String(args.flags.installDir || defaultInstallDir));
  const dryRun = Boolean(args.flags.dryRun);
  const env = await readEnv(installDir);
  const state = await readState(installDir);
  const composeFiles = await composeFilesForInstallDir(installDir);
  const stacks = state.stacks || stackNamesFromComposeFiles(composeFiles);

  if (!Object.keys(env).length) {
    throw new Error(`Nao encontrei .env em ${installDir}. Rode install antes de embed-chatwoot.`);
  }
  if (!stacks.includes("chatwoot") || !stacks.includes("kanban")) {
    throw new Error("Embed exige uma instalacao com Chatwoot e Kanban.");
  }
  if (!env.KANBAN_DOMAIN || !env.CHATWOOT_DOMAIN || !env.CLIENT_ID) {
    throw new Error("Dados de dominio incompletos no .env da instalacao.");
  }

  const routes = proxyRoutesForStacks(env, stacks).map((route) => {
    if (route.domain === env.CHATWOOT_DOMAIN) {
      return {
        ...route,
        advancedConfig: chatwootEmbedAdvancedConfig(env.KANBAN_DOMAIN),
      };
    }
    return route;
  });
  const proxyContainer = args.flags.proxyContainer || detectedProxyContainers()[0];
  const useSsl = !boolFlag(args.flags.noSsl, false);

  panel("Embed Kanban no Chatwoot", [
    `Instalacao: ${installDir}`,
    `Proxy: ${proxyContainer || "nao encontrado"}`,
    `Kanban: https://${env.KANBAN_DOMAIN}`,
    `Chatwoot: https://${env.CHATWOOT_DOMAIN}`,
    `SSL: ${useSsl ? "emitir/reutilizar via NPM" : "nao configurar"}`,
  ]);

  for (const route of routes) {
    console.log(`- ${route.domain} -> http://${route.target}:${route.port}${route.advancedConfig ? " + embed" : ""}`);
  }

  if (!proxyContainer) {
    throw new Error("Nao encontrei container do Nginx Proxy Manager. Use --proxyContainer nome-do-container.");
  }

  if (dryRun) {
    console.log("");
    console.log("[dry-run] configuraria Proxy Hosts no Nginx Proxy Manager");
    console.log(`[dry-run] injetaria script: https://${env.KANBAN_DOMAIN}/dashboard-script.js`);
    return;
  }

  const scriptPath = path.join(os.tmpdir(), `tork-npm-embed-${Date.now()}.mjs`);
  const containerScriptPath = `/tmp/${path.basename(scriptPath)}`;
  await fs.writeFile(scriptPath, npmProxyProvisionScript({ routes, useSsl }), { mode: 0o600 });

  try {
    run("docker", ["cp", scriptPath, `${proxyContainer}:${containerScriptPath}`]);
    run("docker", ["exec", proxyContainer, "node", containerScriptPath]);
  } finally {
    await fs.rm(scriptPath, { force: true });
    spawnSync("docker", ["exec", proxyContainer, "rm", "-f", containerScriptPath], { stdio: "ignore" });
  }

  await writeState(installDir, {
    embeddedChatwoot: true,
    embeddedChatwootAt: new Date().toISOString(),
    embeddedChatwootProxyContainer: proxyContainer,
    embeddedChatwootScriptUrl: `https://${env.KANBAN_DOMAIN}/dashboard-script.js`,
  });

  console.log("Embed aplicado no Chatwoot.");
}

async function statusCommand(args) {
  const installDir = path.resolve(String(args.flags.installDir || defaultInstallDir));
  const generatedDir = path.join(installDir, "generated");
  const files = await composeFilesForInstallDir(installDir);

  if (!files.length) {
    throw new Error(`Nenhum compose encontrado em ${generatedDir}`);
  }

  const projectName = await composeProjectNameForInstallDir(installDir);
  run("docker", ["compose", ...dockerComposeArgs(files, ["ps"], projectName)]);
}

function parseDockerPsJson(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed.split(/\r?\n/).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { status: line };
      }
    });
  }
}

function normalizeContainer(container) {
  return {
    name: container.Name || container.Names || container.name || "",
    service: container.Service || container.service || "",
    state: container.State || container.state || "",
    status: container.Status || container.status || "",
    image: container.Image || container.image || "",
  };
}

function readDiskUsage(targetPath) {
  const result = spawnSync("df", ["-Pk", targetPath], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const lines = result.stdout.trim().split(/\r?\n/);
  const columns = lines[1]?.trim().split(/\s+/);
  if (!columns || columns.length < 6) return null;
  const totalKb = Number(columns[1] || 0);
  const usedKb = Number(columns[2] || 0);
  const availableKb = Number(columns[3] || 0);
  return {
    mount: columns.slice(5).join(" "),
    totalBytes: totalKb * 1024,
    usedBytes: usedKb * 1024,
    availableBytes: availableKb * 1024,
    usedPercent: Number(String(columns[4] || "0").replace("%", "")),
  };
}

function safeMetric(read, fallback) {
  try {
    return read();
  } catch {
    return fallback;
  }
}

async function collectHeartbeatPayload({ installDir, skipDocker }) {
  const state = await readState(installDir);
  const manifest = await readJson(path.join(installDir, "manifest.json")).catch(() => ({}));
  const composeFiles = await composeFilesForInstallDir(installDir);
  let containers = [];

  if (!skipDocker && composeFiles.length) {
    const projectName = await composeProjectNameForInstallDir(installDir);
    const raw = run("docker", ["compose", ...dockerComposeArgs(composeFiles, ["ps", "--format", "json"], projectName)], { capture: true });
    containers = parseDockerPsJson(raw).map(normalizeContainer);
  }

  return {
    ...(await installationIdentity(installDir)),
    cliVersion,
    manifestVersion: manifest.version || state.manifestVersion || "",
    stacks: state.stacks || stackNamesFromComposeFiles(composeFiles),
    lastBackupAt: state.lastBackupAt || null,
    lastUpdateAt: state.lastUpdateAt || null,
    containers,
    resources: {
      platform: safeMetric(() => os.platform(), ""),
      arch: safeMetric(() => os.arch(), ""),
      uptimeSeconds: safeMetric(() => Math.round(os.uptime()), 0),
      loadAverage: safeMetric(() => os.loadavg(), []),
      totalMemoryBytes: safeMetric(() => os.totalmem(), 0),
      freeMemoryBytes: safeMetric(() => os.freemem(), 0),
      disk: readDiskUsage(installDir),
    },
  };
}

async function heartbeatCommand(args) {
  const installDir = path.resolve(String(args.flags.installDir || defaultInstallDir));
  const centralUrl = args.flags.centralUrl || process.env.TORK_CENTRAL_URL;
  const key = args.flags.key || process.env.TORK_INSTALL_KEY;
  const dryRun = Boolean(args.flags.dryRun);
  const skipDocker = Boolean(args.flags.skipDocker || dryRun);
  if (!centralUrl) throw new Error("Informe --centralUrl ou TORK_CENTRAL_URL");
  requireSafeKey(key);

  const payload = await collectHeartbeatPayload({ installDir, skipDocker });
  if (dryRun) {
    console.log(JSON.stringify({ url: new URL("/api/installations/heartbeat", centralUrl).toString(), payload }, null, 2));
    return;
  }

  const response = await fetch(new URL("/api/installations/heartbeat", centralUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": `tork-automation-cli/${cliVersion}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Central recusou heartbeat: HTTP ${response.status}`);
  }
  await writeState(installDir, {
    lastHeartbeatAt: body.data?.lastHeartbeatAt || new Date().toISOString(),
    centralUrl,
  });
  console.log(`Heartbeat enviado: ${body.data?.installationId || "ok"}`);
}

async function promptMissingAdminFlags(flags, fields) {
  const values = { ...flags };
  const missing = fields.filter((field) => !values[field.name]);
  if (!missing.length || values.yes || values.nonInteractive) return values;

  const rl = await createPromptSession();
  try {
    for (const field of missing) {
      const suffix = field.defaultValue ? ` [${field.defaultValue}]` : "";
      const answer = await rl.question(`${field.label}${suffix}: `);
      values[field.name] = answer || field.defaultValue || "";
    }
  } finally {
    rl.close();
  }
  return values;
}

async function centralAdminRequest({ centralUrl, adminToken, path: apiPath, method = "GET", body }) {
  if (!centralUrl) throw new Error("Informe --centralUrl ou TORK_CENTRAL_URL");
  if (!adminToken) throw new Error("Informe --adminToken ou TORK_CENTRAL_ADMIN_TOKEN");

  const response = await fetch(new URL(apiPath, centralUrl), {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "User-Agent": `tork-automation-cli/${cliVersion}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Central recusou requisicao admin: HTTP ${response.status}`);
  }
  return payload;
}

async function centralListCommand(args) {
  const flags = await promptMissingAdminFlags({
    centralUrl: args.flags.centralUrl || process.env.TORK_CENTRAL_URL,
    adminToken: args.flags.adminToken || process.env.TORK_CENTRAL_ADMIN_TOKEN,
    ...args.flags,
  }, [
    { name: "centralUrl", label: "URL da central", defaultValue: "http://127.0.0.1:8095" },
    { name: "adminToken", label: "Token admin" },
  ]);

  const payload = await centralAdminRequest({
    centralUrl: flags.centralUrl,
    adminToken: flags.adminToken,
    path: "/api/admin/install-keys",
  });
  console.log(JSON.stringify(payload.data || payload, null, 2));
}

async function centralCreateKeyCommand(args) {
  const flags = await promptMissingAdminFlags({
    centralUrl: args.flags.centralUrl || process.env.TORK_CENTRAL_URL,
    adminToken: args.flags.adminToken || process.env.TORK_CENTRAL_ADMIN_TOKEN,
    customerId: args.flags.customerId,
    customerName: args.flags.customerName,
    features: args.flags.features || "kanban,chatwoot,n8n,proxy",
    maxUses: args.flags.maxUses || 1,
    ...args.flags,
  }, [
    { name: "centralUrl", label: "URL da central", defaultValue: "http://127.0.0.1:8095" },
    { name: "adminToken", label: "Token admin" },
    { name: "customerId", label: "ID do cliente", defaultValue: `cliente-${Date.now()}` },
    { name: "customerName", label: "Nome do cliente", defaultValue: "Cliente" },
    { name: "features", label: "Stacks liberadas", defaultValue: "kanban,chatwoot,n8n,proxy" },
    { name: "maxUses", label: "Quantidade de usos", defaultValue: "1" },
  ]);

  const payload = await centralAdminRequest({
    centralUrl: flags.centralUrl,
    adminToken: flags.adminToken,
    path: "/api/admin/install-keys",
    method: "POST",
    body: {
      customerId: flags.customerId,
      customerName: flags.customerName,
      email: flags.email || "",
      label: flags.label || "",
      features: String(flags.features || "kanban").split(",").map((item) => item.trim()).filter(Boolean),
      maxUses: Number(flags.maxUses || 1),
      expiresAt: flags.expiresAt || null,
    },
  });
  console.log(JSON.stringify(payload.data || payload, null, 2));
}

async function centralRevokeKeyCommand(args) {
  const flags = await promptMissingAdminFlags({
    centralUrl: args.flags.centralUrl || process.env.TORK_CENTRAL_URL,
    adminToken: args.flags.adminToken || process.env.TORK_CENTRAL_ADMIN_TOKEN,
    id: args.flags.id,
    ...args.flags,
  }, [
    { name: "centralUrl", label: "URL da central", defaultValue: "http://127.0.0.1:8095" },
    { name: "adminToken", label: "Token admin" },
    { name: "id", label: "ID da chave" },
  ]);

  if (!flags.id) throw new Error("Informe --id key_xxx");
  const payload = await centralAdminRequest({
    centralUrl: flags.centralUrl,
    adminToken: flags.adminToken,
    path: `/api/admin/install-keys/${encodeURIComponent(flags.id)}/revoke`,
    method: "POST",
  });
  console.log(JSON.stringify(payload.data || payload, null, 2));
}

async function wizardCommand(args) {
  const defaults = await readJson(args.flags.manifest || defaultManifestPath)
    .then((manifest) => manifest.defaults || {})
    .catch(() => ({}));
  const rl = await createPromptSession();
  const flags = { ...args.flags };
  let preset = stackPreset("full");
  const proxyContainers = detectedProxyContainers();
  const hasSharedProxy = proxyContainers.length > 0;

  try {
    banner("Assistente visual para preparar uma VPS do zero");
    panel("Ambiente", [
      `Assistente visual para preparar uma VPS do zero. v${cliVersion}`,
      "Instala clientes isolados com Docker Compose, rede e secrets proprios.",
      `Dominio base padrao: ${defaultBaseDomain}`,
      hasSharedProxy ? `Proxy existente detectado: ${proxyContainers.join(", ")}` : "Proxy existente detectado: nao",
    ]);

    section("Origem");
    const source = await askChoice(rl, "Escolha", [
      { key: "1", label: "Central com chave de instalacao" },
      { key: "2", label: "Local/GitHub sem central, para teste ou homologacao" },
    ], flags.centralUrl || flags.key || process.env.TORK_CENTRAL_URL || process.env.TORK_INSTALL_KEY ? "1" : "2");

    if (source.key === "1") {
      flags.centralUrl = await askValue(rl, "URL da central", flags.centralUrl || process.env.TORK_CENTRAL_URL || "http://127.0.0.1:8095");
      flags.key = await askValue(rl, "Chave TORK", flags.key || process.env.TORK_INSTALL_KEY || "");
    } else {
      flags.manifest = flags.manifest || defaultManifestPath;
    }

    section("Cliente");
    const suggestedClientName = flags.clientName || defaults.clientName || (flags.newClient ? "Cliente novo" : "principal");
    flags.clientName = await askValue(rl, "Nome do cliente", suggestedClientName);
    flags.clientId = slugifyClientId(await askValue(rl, "ID curto do cliente", flags.clientId || slugifyClientId(flags.clientName)));
    flags.projectName = await askValue(rl, "Projeto Docker Compose", flags.projectName || composeProjectNameForClient(flags.clientId));
    flags.network = await askValue(rl, "Rede Docker isolada", flags.network || networkNameForClient(flags.clientId));
    flags.baseDomain = normalizeBaseDomain(await askValue(rl, "Dominio base", flags.baseDomain || defaults.baseDomain || defaultBaseDomain));

    section("Destino");
    flags.installDir = await askValue(
      rl,
      "Diretorio de instalacao",
      flags.installDir || defaultInstallDirForClient(flags.clientId, defaults.installDir || defaultInstallDir),
    );

    section("Stacks");
    if (hasSharedProxy) {
      console.log(paint("Proxy compartilhado recomendado nesta VPS: use a opcao 2 para nao disputar portas 80/443/81.", color.yellow));
    }
    const stackChoice = await askChoice(rl, "Escolha", [
      { key: "1", label: "Stack completa: proxy + Chatwoot + n8n + Kanban" },
      { key: "2", label: "Cliente completo: Chatwoot + n8n + Kanban, usando proxy existente" },
      { key: "3", label: "Somente Kanban" },
      { key: "4", label: "Chatwoot + Kanban" },
      { key: "5", label: "Somente n8n" },
      { key: "6", label: "Somente Nginx Proxy Manager" },
    ], flags.newClient || hasSharedProxy ? "2" : "1");
    preset = stackPreset({
      "1": "full",
      "2": "client-full",
      "3": "kanban",
      "4": "chatwoot-kanban",
      "5": "n8n",
      "6": "proxy",
    }[stackChoice.key]);

    const stackNames = selectedStackNamesFromPreset(preset);
    const canUseSharedProxy = !stackNames.includes("proxy");
    section("Dominios");
    if (stackNames.includes("kanban")) {
      flags.kanbanDomain = await askValue(rl, "Dominio do Kanban", flags.kanbanDomain || serviceDomain("kanban", flags.clientId, flags.baseDomain));
      flags.kanbanHttpPort = await askValue(rl, "Porta HTTP local do Kanban", flags.kanbanHttpPort || defaultKanbanPortForClient(flags.clientId, defaults.kanbanHttpPort || 8090));
    }
    if (stackNames.includes("chatwoot")) {
      flags.chatwootDomain = await askValue(rl, "Dominio do Chatwoot", flags.chatwootDomain || serviceDomain("chatwoot", flags.clientId, flags.baseDomain));
    }
    if (stackNames.includes("n8n")) {
      flags.n8nDomain = await askValue(rl, "Dominio do n8n", flags.n8nDomain || serviceDomain("n8n", flags.clientId, flags.baseDomain));
    }
    if (canUseSharedProxy) {
      const proxyChoice = await askChoice(rl, "Conectar proxy existente nessa rede", [
        { key: "1", label: "Sim, tentar conectar automaticamente" },
        { key: "2", label: "Nao, farei manualmente" },
      ], hasSharedProxy ? "1" : "2");
      flags.connectProxy = proxyChoice.key === "1";
      flags.sharedProxy = flags.connectProxy;
      flags.exposeKanbanPort = !flags.connectProxy;
    } else if (hasSharedProxy) {
      console.log(paint("Aviso: esta opcao tenta subir outro Nginx Proxy Manager. Se 80/443/81 ja estiverem ocupadas, o compose vai falhar.", color.yellow));
      flags.sharedProxy = false;
    }

    section("Execucao");
    const dryRunChoice = await askChoice(rl, "Modo", [
      { key: "1", label: "Instalar de verdade agora" },
      { key: "2", label: "Dry-run: gerar arquivos sem subir containers" },
    ], flags.dryRun ? "2" : "1");
    flags.dryRun = dryRunChoice.key === "2";
    flags.yes = true;

    panel("Resumo", [
      `Origem: ${source.key === "1" ? "central" : "local/GitHub"}`,
      `Cliente: ${flags.clientName} (${flags.clientId})`,
      `Dominio base: ${flags.baseDomain}`,
      `Projeto Docker: ${flags.projectName}`,
      `Rede Docker: ${flags.network}`,
      `Instalacao: ${flags.installDir}`,
      `Stacks: ${preset.label}`,
      `Proxy compartilhado: ${flags.sharedProxy ? "sim" : "nao"}`,
      ...(flags.kanbanDomain ? [`Kanban: ${flags.kanbanDomain}`] : []),
      ...(flags.chatwootDomain ? [`Chatwoot: ${flags.chatwootDomain}`] : []),
      ...(flags.n8nDomain ? [`n8n: ${flags.n8nDomain}`] : []),
      `Proxy existente: ${flags.connectProxy ? "conectar automaticamente" : "nao alterar"}`,
      `Modo: ${flags.dryRun ? "dry-run" : "instalar agora"}`,
    ]);

    const confirm = await askChoice(rl, "Continuar", [
      { key: "1", label: "Sim, executar" },
      { key: "2", label: "Cancelar" },
    ], "1");
    if (confirm.key !== "1") return undefined;
  } finally {
    rl.close();
  }

  return installCommand({
    ...args,
    flags: { ...flags, ...preset.flags },
    install: preset.install,
  });
}

async function backupCommand(args) {
  const installDir = path.resolve(String(args.flags.installDir || defaultInstallDir));
  const dryRun = Boolean(args.flags.dryRun);
  const includeData = Boolean(args.flags.includeData);
  const composeFiles = await composeFilesForInstallDir(installDir);
  const projectName = await composeProjectNameForInstallDir(installDir);
  const backupRoot = path.resolve(String(args.flags.backupDir || path.join(installDir, "backups")));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = args.flags.name || `tork-backup-${timestamp}`;
  const stagingDir = path.join(backupRoot, `${backupName}.staging`);
  const archivePath = path.join(backupRoot, `${backupName}.tar.gz`);

  if (!composeFiles.length) {
    throw new Error(`Nenhum compose encontrado para backup em ${path.join(installDir, "generated")}`);
  }

  console.log(`Backup: ${archivePath}`);
  console.log(`Instalacao: ${installDir}`);
  console.log(`Dados Postgres: ${includeData ? "sim" : "nao"}`);

  if (dryRun) {
    console.log(`[dry-run] criar snapshot em ${stagingDir}`);
    if (includeData) await dumpPostgresData({ installDir, composeFiles, stagingDir, dryRun, projectName });
    console.log(`[dry-run] tar -czf ${archivePath} -C ${stagingDir} .`);
    return { archivePath };
  }

  await fs.rm(stagingDir, { recursive: true, force: true });
  await ensureDir(stagingDir);
  await copyIfExists(path.join(installDir, "generated"), path.join(stagingDir, "generated"));
  await copyIfExists(path.join(installDir, ".env"), path.join(stagingDir, ".env"));
  await copyIfExists(path.join(installDir, "manifest.json"), path.join(stagingDir, "manifest.json"));
  await copyIfExists(path.join(installDir, ".tork-state.json"), path.join(stagingDir, ".tork-state.json"));

  await writeJson(path.join(stagingDir, "backup-metadata.json"), {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    cliVersion,
    installDir,
    includeData,
    composeFiles: composeFiles.map((file) => path.relative(installDir, file)),
  });

  if (includeData) await dumpPostgresData({ installDir, composeFiles, stagingDir, dryRun: false, projectName });

  await ensureDir(backupRoot);
  run("tar", ["-czf", archivePath, "-C", stagingDir, "."]);
  await fs.rm(stagingDir, { recursive: true, force: true });
  await writeState(installDir, { lastBackup: archivePath, lastBackupAt: new Date().toISOString() });
  console.log(`Backup criado: ${archivePath}`);
  return { archivePath };
}

async function extractBackup({ archivePath, targetDir, dryRun }) {
  if (dryRun) {
    console.log(`[dry-run] tar -xzf ${archivePath} -C ${targetDir}`);
    return;
  }
  await fs.rm(targetDir, { recursive: true, force: true });
  await ensureDir(targetDir);
  run("tar", ["-xzf", archivePath, "-C", targetDir]);
}

async function restoreCommand(args) {
  const installDir = path.resolve(String(args.flags.installDir || defaultInstallDir));
  const archivePath = path.resolve(String(args.flags.file || ""));
  const dryRun = Boolean(args.flags.dryRun);
  const includeData = Boolean(args.flags.includeData);
  const yes = Boolean(args.flags.yes || args.flags.force);
  if (!archivePath || archivePath === path.resolve("")) {
    throw new Error("Informe o arquivo com --file /caminho/backup.tar.gz");
  }
  if (!dryRun && !yes) {
    throw new Error("Restore sobrescreve arquivos da instalacao. Rode com --yes para confirmar.");
  }

  const restoreRoot = path.join(installDir, ".restore-tmp");
  const extractedDir = path.join(restoreRoot, path.basename(archivePath).replace(/\.tar\.gz$/, ""));
  console.log(`Restore: ${archivePath}`);
  console.log(`Destino: ${installDir}`);

  await extractBackup({ archivePath, targetDir: extractedDir, dryRun });
  if (dryRun) {
    console.log(`[dry-run] restaurar generated, .env, manifest.json e .tork-state.json para ${installDir}`);
    if (includeData) {
      const composeFiles = await composeFilesForInstallDir(installDir);
      const projectName = await composeProjectNameForInstallDir(installDir);
      await restorePostgresData({ composeFiles, extractedDir, dryRun, projectName });
    }
    return;
  }

  await ensureDir(installDir);
  await replaceIfExists(path.join(extractedDir, "generated"), path.join(installDir, "generated"));
  await replaceIfExists(path.join(extractedDir, ".env"), path.join(installDir, ".env"));
  await replaceIfExists(path.join(extractedDir, "manifest.json"), path.join(installDir, "manifest.json"));
  await replaceIfExists(path.join(extractedDir, ".tork-state.json"), path.join(installDir, ".tork-state.json"));

  const composeFiles = await composeFilesForInstallDir(installDir);
  const projectName = await composeProjectNameForInstallDir(installDir);
  if (includeData) await restorePostgresData({ composeFiles, extractedDir, dryRun: false, projectName });
  await fs.rm(restoreRoot, { recursive: true, force: true });
  await writeState(installDir, { restoredAt: new Date().toISOString(), restoredFrom: archivePath });
  console.log("Restore concluido.");
}

async function updateCommand(args) {
  const installDir = path.resolve(String(args.flags.installDir || defaultInstallDir));
  const dryRun = Boolean(args.flags.dryRun);
  const skipBackup = Boolean(args.flags.skipBackup);
  const key = args.flags.key || process.env.TORK_INSTALL_KEY || "LOCAL-DEV";
  const manifest = await loadManifest({
    manifestPath: args.flags.manifest,
    centralUrl: args.flags.centralUrl,
    key,
    installation: args.flags.centralUrl ? await installationIdentity(installDir) : undefined,
  });
  const currentValues = await readEnv(installDir);
  if (!Object.keys(currentValues).length) {
    throw new Error(`Nao encontrei .env em ${installDir}. Rode install antes de update.`);
  }
  const existingComposeFiles = await composeFilesForInstallDir(installDir);
  const state = await readState(installDir);
  const stacksRequested = Boolean(args.install.length || args.flags.stack || args.flags.full);
  const stacks = stacksRequested
    ? selectedStacks(args.flags, args.install)
    : state.stacks || stackNamesFromComposeFiles(existingComposeFiles);
  const values = mergeManifestImages(currentValues, manifest);
  const projectName = values.PROJECT_NAME || state.projectName || "";

  let backupResult = null;
  if (!skipBackup) {
    backupResult = await backupCommand({
      ...args,
      flags: {
        ...args.flags,
        installDir,
        name: args.flags.backupName || `pre-update-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      },
    });
  }

  const rendered = await renderStack({ manifest, stacks, values, installDir });
  console.log(`Update: ${manifest.product} ${manifest.version}`);
  console.log(`Stacks: ${stacks.join(", ")}`);

  if (dryRun) {
    console.log(`[dry-run] docker compose ${dockerComposeArgs(rendered.composeFiles, ["pull"], projectName).join(" ")}`);
    console.log(`[dry-run] docker compose ${dockerComposeArgs(rendered.composeFiles, ["up", "-d"], projectName).join(" ")}`);
    return;
  }

  ensureDockerNetwork(values.NETWORK, false);
  run("docker", ["compose", ...dockerComposeArgs(rendered.composeFiles, ["pull"], projectName)]);
  run("docker", ["compose", ...dockerComposeArgs(rendered.composeFiles, ["up", "-d"], projectName)]);
  await writeState(installDir, {
    projectName,
    network: values.NETWORK,
    manifestVersion: manifest.version,
    stacks,
    composeFiles: rendered.composeFiles,
    lastUpdateAt: new Date().toISOString(),
    lastPreUpdateBackup: backupResult?.archivePath,
  });
}

async function rollbackCommand(args) {
  const installDir = path.resolve(String(args.flags.installDir || defaultInstallDir));
  const state = await readState(installDir);
  const archivePath = args.flags.file || state.lastPreUpdateBackup || state.lastBackup;
  if (!archivePath) {
    throw new Error("Nao existe backup salvo para rollback. Informe --file /caminho/backup.tar.gz");
  }
  await restoreCommand({
    ...args,
    flags: {
      ...args.flags,
      installDir,
      file: archivePath,
    },
  });
  const composeFiles = await composeFilesForInstallDir(installDir);
  const projectName = await composeProjectNameForInstallDir(installDir);
  if (args.flags.dryRun) {
    console.log(`[dry-run] docker compose ${dockerComposeArgs(composeFiles, ["up", "-d"], projectName).join(" ")}`);
    return;
  }
  run("docker", ["compose", ...dockerComposeArgs(composeFiles, ["up", "-d"], projectName)]);
  await writeState(installDir, { rolledBackAt: new Date().toISOString(), rolledBackFrom: archivePath });
}

async function menuCommand(args) {
  const rl = await createPromptSession();
  let choice = "";
  try {
    banner("Painel visual para instalar, atualizar e operar clientes");
    panel("Menu Principal", [
      "1. Assistente visual de instalacao/configuracao da VPS",
      "2. Configurar novo cliente nesta VPS",
      "3. Instalar stack completa em VPS zerada",
      "4. Instalar apenas Kanban",
      "5. Instalar Chatwoot + Kanban",
      "6. Instalar n8n",
      "7. Embedar Kanban no Chatwoot",
      "8. Ver status",
      "9. Backup",
      "10. Update",
      "11. Rollback",
      "12. Enviar heartbeat",
      "13. Criar chave na central",
      "14. Listar central",
      "15. Sair",
    ]);
    choice = await rl.question("Selecione uma opcao: ");
  } finally {
    rl.close();
  }

  if (choice === "1") return wizardCommand(args);
  if (choice === "2") return wizardCommand({ ...args, flags: { ...args.flags, newClient: true } });
  if (choice === "3") return installCommand({ ...args, flags: { ...args.flags, full: true }, install: [] });
  if (choice === "4") return installCommand({ ...args, install: ["kanban"] });
  if (choice === "5") return installCommand({ ...args, install: ["chatwoot", "kanban"] });
  if (choice === "6") return installCommand({ ...args, install: ["n8n"] });
  if (choice === "7") return embedChatwootCommand(args);
  if (choice === "8") return statusCommand(args);
  if (choice === "9") return backupCommand(args);
  if (choice === "10") return updateCommand(args);
  if (choice === "11") return rollbackCommand({ ...args, flags: { ...args.flags, yes: true } });
  if (choice === "12") return heartbeatCommand(args);
  if (choice === "13") return centralCreateKeyCommand(args);
  if (choice === "14") return centralListCommand(args);
  return undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "install") return installCommand(args);
  if (args.command === "status") return statusCommand(args);
  if (args.command === "embed-chatwoot") return embedChatwootCommand(args);
  if (args.command === "backup") return backupCommand(args);
  if (args.command === "restore") return restoreCommand(args);
  if (args.command === "update") return updateCommand(args);
  if (args.command === "rollback") return rollbackCommand(args);
  if (args.command === "heartbeat") return heartbeatCommand(args);
  if (args.command === "wizard" || args.command === "setup") return wizardCommand(args);
  if (args.command === "new-client") return wizardCommand({ ...args, flags: { ...args.flags, newClient: true } });
  if (args.command === "central-list") return centralListCommand(args);
  if (args.command === "central-create-key") return centralCreateKeyCommand(args);
  if (args.command === "central-revoke-key") return centralRevokeKeyCommand(args);
  if (args.command === "menu") return menuCommand(args);
  if (args.command === "version") {
    console.log(`tork-automation ${cliVersion}`);
    return undefined;
  }

  throw new Error(`Comando desconhecido: ${args.command}`);
}

main().catch((error) => {
  console.error(`Erro: ${error.message}`);
  process.exit(1);
});
