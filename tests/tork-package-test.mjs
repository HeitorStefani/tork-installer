import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const distDir = path.join(root, "dist");
const bootstrapDir = "/private/tmp/tork-bootstrap-test";
const bootstrapBin = "/private/tmp/tork-bootstrap-bin";
const githubSourceDir = "/private/tmp/tork-github-source";
const githubArchive = "/private/tmp/tork-github-source.tgz";
const githubBootstrapDir = "/private/tmp/tork-github-bootstrap-test";
const githubBootstrapBin = "/private/tmp/tork-github-bootstrap-bin";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

run("sh", ["-n", "install.sh"]);
run("scripts/build-installer-package.sh", []);

const files = await fs.readdir(distDir);
for (const required of ["install.sh", "install.sh.sha256", "tork-package.tgz", "tork-package.tgz.sha256"]) {
  assert(files.includes(required), `dist must include ${required}`);
}

const packageListing = run("tar", ["-tzf", path.join(distDir, "tork-package.tgz")]);
assert(packageListing.includes("./cli/tork-automation.mjs"), "package must include CLI");
assert(packageListing.includes("./backend/Dockerfile"), "package must include Kanban backend Dockerfile");
assert(packageListing.includes("./frontend/Dockerfile"), "package must include Kanban frontend Dockerfile");
assert(packageListing.includes("./central/src/server.mjs"), "package must include central source");
assert(!packageListing.includes("central/data"), "package must not include central data");
assert(!packageListing.includes("admin-token"), "package must not include admin token");
assert(!packageListing.includes("local-central.env"), "package must not include local central env");
assert(!packageListing.includes("start-local-central.sh"), "package must not include local start script");

run("shasum", ["-a", "256", "-c", path.join(distDir, "install.sh.sha256")], { cwd: distDir });
run("shasum", ["-a", "256", "-c", path.join(distDir, "tork-package.tgz.sha256")], { cwd: distDir });

await fs.rm(bootstrapDir, { recursive: true, force: true });
await fs.rm(bootstrapBin, { recursive: true, force: true });
await fs.mkdir(bootstrapBin, { recursive: true });
run("sh", [path.join(distDir, "install.sh")], {
  env: {
    ...process.env,
    TORK_SKIP_DEPENDENCIES: "1",
    TORK_BOOTSTRAP_ONLY: "1",
    TORK_NO_SUDO: "1",
    TORK_HOME: bootstrapDir,
    BIN_DIR: bootstrapBin,
    TORK_PACKAGE_URL: pathToFileURL(path.join(distDir, "tork-package.tgz")).toString(),
  },
});

const version = run(path.join(bootstrapBin, "tork-automation"), ["version"]);
assert(version.includes("0.2.0"), "bootstrap-installed CLI must run");

await fs.rm(githubSourceDir, { recursive: true, force: true });
await fs.rm(githubArchive, { force: true });
await fs.rm(githubBootstrapDir, { recursive: true, force: true });
await fs.rm(githubBootstrapBin, { recursive: true, force: true });
await fs.mkdir(path.join(githubSourceDir, "tork-repo-main"), { recursive: true });
for (const entry of ["install.sh", "cli", "manifests", "templates", "backend", "frontend", "docs"]) {
  await fs.cp(path.join(root, entry), path.join(githubSourceDir, "tork-repo-main", entry), { recursive: true });
}
await fs.mkdir(path.join(githubSourceDir, "tork-repo-main", "central"), { recursive: true });
await fs.cp(path.join(root, "central", "src"), path.join(githubSourceDir, "tork-repo-main", "central", "src"), { recursive: true });
run("tar", ["-czf", githubArchive, "-C", githubSourceDir, "tork-repo-main"]);
await fs.mkdir(githubBootstrapBin, { recursive: true });
run("sh", [path.join(distDir, "install.sh")], {
  env: {
    ...process.env,
    TORK_SKIP_DEPENDENCIES: "1",
    TORK_BOOTSTRAP_ONLY: "1",
    TORK_NO_SUDO: "1",
    TORK_HOME: githubBootstrapDir,
    BIN_DIR: githubBootstrapBin,
    TORK_GITHUB_REPO: "tork/test-repo",
    TORK_GITHUB_ARCHIVE_URL: pathToFileURL(githubArchive).toString(),
  },
});

const githubVersion = run(path.join(githubBootstrapBin, "tork-automation"), ["version"]);
assert(githubVersion.includes("0.2.0"), "GitHub archive bootstrap-installed CLI must run");

console.log(JSON.stringify({ ok: true, files: files.length }));
