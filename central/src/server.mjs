#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { URL } from "node:url";
import path from "node:path";
import { JsonStore, installationFingerprint, sha256 } from "./store.mjs";
import { buildManifest } from "./manifest.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const config = {
  port: Number(process.env.TORK_CENTRAL_PORT || 8095),
  host: process.env.TORK_CENTRAL_HOST || "0.0.0.0",
  dbPath: process.env.TORK_CENTRAL_DB || path.join(root, "central", "data", "central-db.json"),
  adminToken: process.env.TORK_CENTRAL_ADMIN_TOKEN || "",
  baseManifestPath: process.env.TORK_BASE_MANIFEST || path.join(root, "manifests", "tork-stack.local.json"),
  publicFilesDir: process.env.TORK_PUBLIC_FILES_DIR || path.join(root, "dist"),
  corsOrigin: process.env.TORK_CENTRAL_CORS_ORIGIN || "*",
};

const store = new JsonStore(config.dbPath);

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": config.corsOrigin,
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function sendJson(res, status, body) {
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function sendBuffer(res, status, body, contentType) {
  res.writeHead(status, {
    ...headers,
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) throw httpError(413, "Payload too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "Invalid JSON");
  }
}

function bearer(req) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

function requireAdmin(req) {
  if (!config.adminToken) throw httpError(500, "TORK_CENTRAL_ADMIN_TOKEN is not configured");
  if (bearer(req) !== config.adminToken) throw httpError(401, "Invalid admin token");
}

function requireInstallKey(req) {
  const key = bearer(req);
  if (!/^TORK-[A-Z0-9-]{8,80}$/.test(key)) throw httpError(401, "Invalid install key");
  return key;
}

function publicIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
}

function installerFile(pathname) {
  const files = {
    "/install.sh": { name: "install.sh", type: "text/x-shellscript; charset=utf-8" },
    "/install.sh.sha256": { name: "install.sh.sha256", type: "text/plain; charset=utf-8" },
    "/tork-package.tgz": { name: "tork-package.tgz", type: "application/gzip" },
    "/tork-package.tgz.sha256": { name: "tork-package.tgz.sha256", type: "text/plain; charset=utf-8" },
  };
  return files[pathname] || null;
}

async function validateInstallKey(key, body, req, action = "manifest.requested") {
  const now = new Date();
  return store.update((data) => {
    const keyHash = sha256(key);
    const record = data.installKeys.find((item) => item.keyHash === keyHash);
    if (!record) throw httpError(401, "Install key not found");
    if (record.revokedAt) throw httpError(403, "Install key revoked");
    if (record.expiresAt && new Date(record.expiresAt) <= now) throw httpError(403, "Install key expired");

    const customer = data.customers.find((item) => item.id === record.customerId);
    if (!customer || customer.revokedAt) throw httpError(403, "Customer is not active");

    const fingerprint = installationFingerprint({ ...body, publicIp: publicIp(req) });
    let installation = data.installations.find((item) => item.installKeyId === record.id && item.fingerprint === fingerprint);

    if (!installation) {
      if (record.maxUses && record.usedCount >= record.maxUses) throw httpError(403, "Install key already used");
      installation = {
        id: cryptoRandomId("inst"),
        installKeyId: record.id,
        customerId: record.customerId,
        fingerprint,
        hostname: body.hostname || "",
        installDir: body.installDir || "",
        publicIp: publicIp(req),
        firstSeenAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        lastHeartbeatAt: null,
        status: null,
        revokedAt: null,
      };
      data.installations.push(installation);
      record.usedCount += 1;
      record.usedAt = now.toISOString();
    } else {
      installation.lastSeenAt = now.toISOString();
      installation.publicIp = publicIp(req);
    }

    data.auditLog.push({
      id: cryptoRandomId("audit"),
      actor: installation.id,
      action,
      payload: { customerId: record.customerId, installKeyId: record.id },
      createdAt: now.toISOString(),
    });

    return {
      customer,
      installKey: record,
      installation,
      license: {
        customerId: customer.id,
        installationId: installation.id,
        installKeyId: record.id,
        features: record.features,
        expiresAt: record.expiresAt || customer.expiresAt || null,
      },
    };
  });
}

function sanitizeHeartbeat(body) {
  const resources = body.resources && typeof body.resources === "object" ? body.resources : {};
  const containers = Array.isArray(body.containers) ? body.containers.slice(0, 100).map((container) => ({
    name: String(container.name || "").slice(0, 160),
    service: String(container.service || "").slice(0, 120),
    state: String(container.state || "").slice(0, 80),
    status: String(container.status || "").slice(0, 240),
    image: String(container.image || "").slice(0, 240),
  })) : [];

  return {
    cliVersion: String(body.cliVersion || "").slice(0, 40),
    manifestVersion: String(body.manifestVersion || "").slice(0, 80),
    stacks: Array.isArray(body.stacks) ? body.stacks.map((item) => String(item).slice(0, 80)).slice(0, 20) : [],
    installDir: String(body.installDir || "").slice(0, 240),
    hostname: String(body.hostname || "").slice(0, 160),
    publicUrl: String(body.publicUrl || "").slice(0, 240),
    lastBackupAt: body.lastBackupAt || null,
    lastUpdateAt: body.lastUpdateAt || null,
    containers,
    resources: {
      platform: String(resources.platform || "").slice(0, 80),
      arch: String(resources.arch || "").slice(0, 40),
      uptimeSeconds: Number(resources.uptimeSeconds || 0),
      loadAverage: Array.isArray(resources.loadAverage) ? resources.loadAverage.slice(0, 3).map(Number) : [],
      totalMemoryBytes: Number(resources.totalMemoryBytes || 0),
      freeMemoryBytes: Number(resources.freeMemoryBytes || 0),
      disk: resources.disk && typeof resources.disk === "object" ? {
        mount: String(resources.disk.mount || "").slice(0, 120),
        totalBytes: Number(resources.disk.totalBytes || 0),
        usedBytes: Number(resources.disk.usedBytes || 0),
        availableBytes: Number(resources.disk.availableBytes || 0),
        usedPercent: Number(resources.disk.usedPercent || 0),
      } : null,
    },
  };
}

function cryptoRandomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function adminList(res) {
  const data = await store.read();
  sendJson(res, 200, {
    ok: true,
    data: {
      customers: data.customers,
      installKeys: data.installKeys.map(({ keyHash, ...item }) => item),
      installations: data.installations,
    },
  });
}

async function adminCreateKey(req, res) {
  const body = await readJson(req);
  const now = new Date().toISOString();
  const plainKey = body.key || `TORK-${crypto.randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase().match(/.{1,4}/g).join("-")}`;
  const customerId = body.customerId || `cust_${crypto.randomUUID()}`;
  const features = Array.isArray(body.features) && body.features.length ? body.features : ["kanban"];

  const result = await store.update((data) => {
    let customer = data.customers.find((item) => item.id === customerId);
    if (!customer) {
      customer = {
        id: customerId,
        name: body.customerName || customerId,
        email: body.email || "",
        createdAt: now,
        expiresAt: body.customerExpiresAt || null,
        revokedAt: null,
      };
      data.customers.push(customer);
    }

    const installKey = {
      id: `key_${crypto.randomUUID()}`,
      customerId,
      keyHash: sha256(plainKey),
      label: body.label || "",
      features,
      maxUses: Number(body.maxUses || 1),
      usedCount: 0,
      expiresAt: body.expiresAt || null,
      createdAt: now,
      usedAt: null,
      revokedAt: null,
    };
    data.installKeys.push(installKey);
    data.auditLog.push({
      id: cryptoRandomId("audit"),
      actor: "admin",
      action: "install_key.created",
      payload: { customerId, installKeyId: installKey.id, features },
      createdAt: now,
    });

    const { keyHash, ...safeKey } = installKey;
    return { customer, installKey: safeKey, key: plainKey };
  });

  sendJson(res, 201, { ok: true, data: result });
}

async function adminRevoke(pathname, res) {
  const id = pathname.split("/").pop();
  const revokedAt = new Date().toISOString();
  const updated = await store.update((data) => {
    const key = data.installKeys.find((item) => item.id === id);
    if (!key) throw httpError(404, "Install key not found");
    key.revokedAt = revokedAt;
    data.auditLog.push({
      id: cryptoRandomId("audit"),
      actor: "admin",
      action: "install_key.revoked",
      payload: { installKeyId: id },
      createdAt: revokedAt,
    });
    const { keyHash, ...safeKey } = key;
    return safeKey;
  });
  sendJson(res, 200, { ok: true, data: updated });
}

async function handleManifest(req, res) {
  const key = requireInstallKey(req);
  const body = req.method === "POST" ? await readJson(req) : {};
  const validation = await validateInstallKey(key, body, req);
  const manifest = await buildManifest({
    baseManifestPath: config.baseManifestPath,
    license: validation.license,
  });
  sendJson(res, 200, { ok: true, data: manifest });
}

async function handleHeartbeat(req, res) {
  const key = requireInstallKey(req);
  const body = await readJson(req);
  const validation = await validateInstallKey(key, body, req, "installation.heartbeat");
  const now = new Date().toISOString();
  const status = sanitizeHeartbeat(body);
  const updated = await store.update((data) => {
    const installation = data.installations.find((item) => item.id === validation.installation.id);
    if (!installation) throw httpError(404, "Installation not found");
    installation.hostname = status.hostname || installation.hostname;
    installation.installDir = status.installDir || installation.installDir;
    installation.lastSeenAt = now;
    installation.lastHeartbeatAt = now;
    installation.status = status;
    data.auditLog.push({
      id: cryptoRandomId("audit"),
      actor: installation.id,
      action: "installation.status.updated",
      payload: {
        customerId: installation.customerId,
        manifestVersion: status.manifestVersion,
        stacks: status.stacks,
      },
      createdAt: now,
    });
    return installation;
  });
  sendJson(res, 200, { ok: true, data: { installationId: updated.id, lastHeartbeatAt: updated.lastHeartbeatAt } });
}

async function handleInstallerFile(pathname, res) {
  const file = installerFile(pathname);
  if (!file) return false;
  const filePath = path.join(config.publicFilesDir, file.name);
  try {
    const body = await fs.readFile(filePath);
    sendBuffer(res, 200, body, file.type);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw httpError(404, `Installer file not found: ${file.name}`);
    }
    throw error;
  }
  return true;
}

async function route(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (pathname === "/health" && req.method === "GET") return sendJson(res, 200, { ok: true });
  if (req.method === "GET" && installerFile(pathname)) return handleInstallerFile(pathname, res);
  if (pathname === "/api/installations/manifest" && ["GET", "POST"].includes(req.method)) return handleManifest(req, res);
  if (pathname === "/api/installations/heartbeat" && req.method === "POST") return handleHeartbeat(req, res);

  if (pathname === "/api/admin/install-keys" && req.method === "GET") {
    requireAdmin(req);
    return adminList(res);
  }
  if (pathname === "/api/admin/install-keys" && req.method === "POST") {
    requireAdmin(req);
    return adminCreateKey(req, res);
  }
  if (pathname.startsWith("/api/admin/install-keys/") && pathname.endsWith("/revoke") && req.method === "POST") {
    requireAdmin(req);
    return adminRevoke(pathname.replace(/\/revoke$/, ""), res);
  }

  sendJson(res, 404, { ok: false, error: "Route not found" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    sendJson(res, Number(error.statusCode || 500), {
      ok: false,
      error: Number(error.statusCode || 500) >= 500 ? "Internal server error" : error.message,
    });
  });
});

server.listen(config.port, config.host, () => {
  console.log(`Tork central listening on ${config.host}:${config.port}`);
});
