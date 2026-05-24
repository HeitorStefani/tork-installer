import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dbPath = "/private/tmp/tork-central-test.json";
const installDir = "/private/tmp/tork-central-install";
const adminToken = "admin-test-token";
const port = 18995;
const centralUrl = `http://127.0.0.1:${port}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, TORK_CENTRAL_DB: dbPath, ...(options.env || {}) },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

async function waitForHealth() {
  for (let i = 0; i < 30; i += 1) {
    const response = await fetch(`${centralUrl}/health`).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("central health timeout");
}

await fs.rm(dbPath, { force: true });
await fs.rm(installDir, { recursive: true, force: true });

const created = JSON.parse(run("node", [
  "central/src/admin.mjs",
  "create-key",
  "--customerId",
  "cliente-central-test",
  "--features",
  "kanban,chatwoot,n8n,proxy",
  "--maxUses",
  "2",
]));
assert(created.key.startsWith("TORK-"), "admin must return plain install key once");

const server = spawn("node", ["central/src/server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    TORK_CENTRAL_DB: dbPath,
    TORK_CENTRAL_PORT: String(port),
    TORK_CENTRAL_HOST: "127.0.0.1",
    TORK_CENTRAL_ADMIN_TOKEN: adminToken,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForHealth();

  const installerResponse = await fetch(`${centralUrl}/install.sh`);
  assert(installerResponse.status === 200, "central must serve install.sh");
  const installerText = await installerResponse.text();
  assert(installerText.includes("Tork Automation bootstrap"), "install.sh must be the bootstrap script");

  const packageResponse = await fetch(`${centralUrl}/tork-package.tgz`);
  assert(packageResponse.status === 200, "central must serve tork package");
  const packageBytes = await packageResponse.arrayBuffer();
  assert(packageBytes.byteLength > 1024, "tork package must not be empty");

  const unauthorized = await fetch(`${centralUrl}/api/installations/manifest`, {
    headers: { Authorization: "Bearer TORK-BAD-KEY" },
  });
  assert(unauthorized.status === 401, "bad install key must be rejected");

  const manifestResponse = await fetch(`${centralUrl}/api/installations/manifest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${created.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ hostname: "test-vps", installDir }),
  });
  assert(manifestResponse.status === 200, "valid install key must return manifest");
  const manifestPayload = await manifestResponse.json();
  assert(manifestPayload.data.license.customerId === "cliente-central-test", "manifest must include license customer");
  assert(manifestPayload.data.stacks.kanban, "manifest must include authorized kanban stack");

  const adminList = await fetch(`${centralUrl}/api/admin/install-keys`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert(adminList.status === 200, "admin list must accept admin token");

  const cliCreated = JSON.parse(run("node", [
    "cli/tork-automation.mjs",
    "central-create-key",
    "--centralUrl",
    centralUrl,
    "--adminToken",
    adminToken,
    "--customerId",
    "cliente-cli-admin",
    "--customerName",
    "Cliente CLI Admin",
    "--features",
    "kanban,proxy",
    "--maxUses",
    "1",
    "--yes",
  ]));
  assert(cliCreated.key.startsWith("TORK-"), "CLI central-create-key must return a plain key");

  const cliList = JSON.parse(run("node", [
    "cli/tork-automation.mjs",
    "central-list",
    "--centralUrl",
    centralUrl,
    "--adminToken",
    adminToken,
  ]));
  assert(cliList.customers.some((item) => item.id === "cliente-cli-admin"), "CLI central-list must include created customer");

  const cliRevoked = JSON.parse(run("node", [
    "cli/tork-automation.mjs",
    "central-revoke-key",
    "--centralUrl",
    centralUrl,
    "--adminToken",
    adminToken,
    "--id",
    cliCreated.installKey.id,
  ]));
  assert(cliRevoked.revokedAt, "CLI central-revoke-key must mark key as revoked");

  const cliOutput = run("node", [
    "cli/tork-automation.mjs",
    "install",
    "--yes",
    "--dryRun",
    "--centralUrl",
    centralUrl,
    "--key",
    created.key,
    "--installDir",
    installDir,
    "--full",
  ]);
  assert(cliOutput.includes("[dry-run] docker compose"), "CLI must consume central manifest");

  const generated = await fs.readdir(path.join(installDir, "generated"));
  assert(generated.length === 4, "central CLI install must generate all compose files");

  const heartbeatOutput = run("node", [
    "cli/tork-automation.mjs",
    "heartbeat",
    "--centralUrl",
    centralUrl,
    "--key",
    created.key,
    "--installDir",
    installDir,
    "--skipDocker",
  ]);
  assert(heartbeatOutput.includes("Heartbeat enviado:"), "CLI heartbeat must be accepted by central");

  const adminAfterHeartbeat = await fetch(`${centralUrl}/api/admin/install-keys`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const adminPayload = await adminAfterHeartbeat.json();
  const installationWithStatus = adminPayload.data.installations.find((item) => item.status?.cliVersion);
  assert(installationWithStatus, "admin list must expose installation heartbeat status");
  assert(installationWithStatus.status.resources.totalMemoryBytes > 0, "heartbeat must include resource metrics");

  console.log(JSON.stringify({ ok: true, generated: generated.length }));
} finally {
  server.kill("SIGTERM");
}
