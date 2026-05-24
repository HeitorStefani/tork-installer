#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { JsonStore, sha256 } from "./store.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const dbPath = process.env.TORK_CENTRAL_DB || path.join(root, "central", "data", "central-db.json");
const store = new JsonStore(dbPath);

function parseArgs(argv) {
  const args = { command: argv[0] || "help", flags: {} };
  for (let i = 1; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    args.flags[key] = value;
  }
  return args;
}

function installKey() {
  const body = crypto.randomBytes(18).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
  return `TORK-${body.match(/.{1,4}/g).join("-")}`;
}

async function createKey(flags) {
  const now = new Date().toISOString();
  const key = flags.key || installKey();
  const customerId = flags.customerId || `cust_${crypto.randomUUID()}`;
  const features = String(flags.features || "kanban").split(",").map((item) => item.trim()).filter(Boolean);

  const data = await store.update((db) => {
    let customer = db.customers.find((item) => item.id === customerId);
    if (!customer) {
      customer = {
        id: customerId,
        name: flags.customerName || customerId,
        email: flags.email || "",
        createdAt: now,
        expiresAt: flags.customerExpiresAt || null,
        revokedAt: null,
      };
      db.customers.push(customer);
    }

    const installKeyRecord = {
      id: `key_${crypto.randomUUID()}`,
      customerId,
      keyHash: sha256(key),
      label: flags.label || "",
      features,
      maxUses: Number(flags.maxUses || 1),
      usedCount: 0,
      expiresAt: flags.expiresAt || null,
      createdAt: now,
      usedAt: null,
      revokedAt: null,
    };
    db.installKeys.push(installKeyRecord);
    db.auditLog.push({
      id: `audit_${crypto.randomUUID()}`,
      actor: "admin-cli",
      action: "install_key.created",
      payload: { customerId, installKeyId: installKeyRecord.id, features },
      createdAt: now,
    });

    const { keyHash, ...safeRecord } = installKeyRecord;
    return { customer, installKey: safeRecord, key };
  });

  console.log(JSON.stringify(data, null, 2));
}

async function list() {
  const db = await store.read();
  console.log(JSON.stringify({
    customers: db.customers,
    installKeys: db.installKeys.map(({ keyHash, ...item }) => item),
    installations: db.installations,
  }, null, 2));
}

async function revoke(flags) {
  if (!flags.id) throw new Error("--id e obrigatorio");
  const revokedAt = new Date().toISOString();
  const record = await store.update((db) => {
    const key = db.installKeys.find((item) => item.id === flags.id);
    if (!key) throw new Error("Chave nao encontrada");
    key.revokedAt = revokedAt;
    db.auditLog.push({
      id: `audit_${crypto.randomUUID()}`,
      actor: "admin-cli",
      action: "install_key.revoked",
      payload: { installKeyId: flags.id },
      createdAt: revokedAt,
    });
    const { keyHash, ...safeRecord } = key;
    return safeRecord;
  });
  console.log(JSON.stringify(record, null, 2));
}

function serve(flags) {
  const port = flags.port || process.env.TORK_CENTRAL_PORT || "8095";
  const result = spawnSync("node", [path.join(root, "central", "src", "server.mjs")], {
    stdio: "inherit",
    env: { ...process.env, TORK_CENTRAL_PORT: String(port) },
  });
  process.exit(result.status || 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "create-key") return createKey(args.flags);
  if (args.command === "list") return list();
  if (args.command === "revoke-key") return revoke(args.flags);
  if (args.command === "serve") return serve(args.flags);

  console.log(`Comandos:
  node central/src/admin.mjs create-key --customerId cliente1 --features kanban,chatwoot,n8n,proxy
  node central/src/admin.mjs list
  node central/src/admin.mjs revoke-key --id key_xxx
  node central/src/admin.mjs serve --port 8095`);
}

main().catch((error) => {
  console.error(`Erro: ${error.message}`);
  process.exit(1);
});
