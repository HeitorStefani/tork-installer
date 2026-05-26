import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const installDir = "/private/tmp/tork-cli-test";
const clientInstallDir = "/private/tmp/tork-cli-client-test";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(args) {
  const result = spawnSync("node", [path.join(root, "cli", "tork-automation.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function runWithInput(args, input) {
  const result = spawnSync("node", [path.join(root, "cli", "tork-automation.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    input,
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

await fs.rm(installDir, { recursive: true, force: true });
await fs.rm("/private/tmp/tork-cli-wizard-test", { recursive: true, force: true });
await fs.rm(clientInstallDir, { recursive: true, force: true });

const version = run(["version"]);
assert(version.includes("0.2.0"), "version output must include version");

const output = run([
  "install",
  "--yes",
  "--dryRun",
  "--manifest",
  "manifests/tork-stack.local.json",
  "--installDir",
  installDir,
  "--full",
]);
assert(output.includes("[dry-run] docker compose"), "dry-run output must show docker compose command");

const wizardOutput = runWithInput([
  "wizard",
  "--manifest",
  "manifests/tork-stack.local.json",
  "--installDir",
  "/private/tmp/tork-cli-wizard-test",
], "2\n\n\n\n\n\n\n1\n\n\n\n\n2\n1\n");
assert(wizardOutput.includes("Assistente visual"), "wizard must render visual setup");
assert(wizardOutput.includes("[dry-run] docker compose"), "wizard dry-run must generate compose plan");

const clientOutput = run([
  "install",
  "--yes",
  "--dryRun",
  "--manifest",
  "manifests/tork-stack.local.json",
  "--installDir",
  clientInstallDir,
  "--clientId",
  "Cliente Acme",
  "--clientName",
  "Cliente Acme",
  "--stack",
  "kanban",
  "--kanbanHttpPort",
  "8181",
]);
assert(clientOutput.includes("Cliente: Cliente Acme (cliente-acme)"), "client install must show isolated client id");
assert(clientOutput.includes("--project-name tork-cliente-acme"), "client install must use an isolated compose project");

const generated = await fs.readdir(path.join(installDir, "generated"));
assert(generated.includes("kanban.compose.yml"), "kanban compose must be generated");
assert(generated.includes("chatwoot.compose.yml"), "chatwoot compose must be generated");
assert(generated.includes("n8n.compose.yml"), "n8n compose must be generated");
assert(generated.includes("proxy.compose.yml"), "proxy compose must be generated");

for (const file of generated) {
  const content = await fs.readFile(path.join(installDir, "generated", file), "utf8");
  assert(!content.includes("{{"), `${file} has unresolved template token`);
}

const kanban = await fs.readFile(path.join(installDir, "generated", "kanban.compose.yml"), "utf8");
assert(kanban.includes('CORS_ORIGIN: "*"'), "CORS wildcard must be quoted");
assert(kanban.includes("healthcheck:"), "kanban compose must include healthchecks");
assert(kanban.includes("context: ../backend"), "kanban backend must build from packaged source");
assert(kanban.includes("context: ../frontend"), "kanban frontend must build from packaged source");
assert(kanban.includes("principal-kanban-frontend"), "kanban compose must include a client-specific frontend alias");

const clientKanban = await fs.readFile(path.join(clientInstallDir, "generated", "kanban.compose.yml"), "utf8");
assert(clientKanban.includes("tork-cliente-acme-infra"), "client compose must use an isolated network");
assert(clientKanban.includes("cliente-acme-kanban-frontend"), "client compose must include isolated aliases");
assert(clientKanban.includes("https://kanban-cliente-acme.sistemasautomacao.store"), "client compose must derive Kanban domain from base domain");
assert(clientKanban.includes('"8181:80"'), "client compose must honor custom Kanban port");

const env = await fs.readFile(path.join(installDir, ".env"), "utf8");
assert(env.includes("KANBAN_API_KEY="), ".env must include generated Kanban API key");
assert(env.includes("N8N_ENCRYPTION_KEY="), ".env must include generated n8n encryption key");
assert(env.includes("PROJECT_NAME=tork-principal"), ".env must include compose project name");
assert(env.includes("BASE_DOMAIN=sistemasautomacao.store"), ".env must include base domain");

const backupOutput = run([
  "backup",
  "--installDir",
  installDir,
  "--name",
  "test-config-backup",
]);
assert(backupOutput.includes("Backup criado:"), "backup command must create archive");

const backupPath = path.join(installDir, "backups", "test-config-backup.tar.gz");
const backupStat = await fs.stat(backupPath);
assert(backupStat.size > 0, "backup archive must not be empty");

const restoreOutput = run([
  "restore",
  "--installDir",
  installDir,
  "--file",
  backupPath,
  "--dryRun",
]);
assert(restoreOutput.includes("[dry-run] restaurar"), "restore dry-run must show restore plan");

const updateOutput = run([
  "update",
  "--installDir",
  installDir,
  "--manifest",
  "manifests/tork-stack.local.json",
  "--dryRun",
]);
assert(updateOutput.includes("[dry-run] docker compose"), "update dry-run must show docker compose plan");

const rollbackOutput = run([
  "rollback",
  "--installDir",
  installDir,
  "--dryRun",
]);
assert(rollbackOutput.includes("[dry-run] docker compose"), "rollback dry-run must show docker compose plan");

const heartbeatOutput = run([
  "heartbeat",
  "--installDir",
  installDir,
  "--centralUrl",
  "http://127.0.0.1:1",
  "--key",
  "TORK-TEST-KEY1",
  "--dryRun",
]);
assert(heartbeatOutput.includes("\"payload\""), "heartbeat dry-run must print payload");
assert(heartbeatOutput.includes("\"resources\""), "heartbeat payload must include resources");

const state = JSON.parse(await fs.readFile(path.join(installDir, ".tork-state.json"), "utf8"));
assert(state.lastBackup?.endsWith("test-config-backup.tar.gz"), "state must record last backup");

console.log(JSON.stringify({ ok: true, generated: generated.length }));
