import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const defaultDb = {
  schemaVersion: 1,
  customers: [],
  installKeys: [],
  installations: [],
  auditLog: [],
};

export function randomInstallKey() {
  const body = crypto.randomBytes(18).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
  return `TORK-${body.match(/.{1,4}/g).join("-")}`;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function installationFingerprint(input = {}) {
  const raw = [
    input.machineId || "",
    input.hostname || "",
    input.publicIp || "",
    input.installDir || "",
  ].join("|");
  return sha256(raw || crypto.randomUUID());
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.lock = Promise.resolve();
  }

  async read() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      return {
        ...defaultDb,
        ...data,
        customers: data.customers || [],
        installKeys: data.installKeys || [],
        installations: data.installations || [],
        auditLog: data.auditLog || [],
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return structuredClone(defaultDb);
    }
  }

  async write(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  async update(mutator) {
    const run = async () => {
      const data = await this.read();
      const result = await mutator(data);
      await this.write(data);
      return result;
    };

    this.lock = this.lock.then(run, run);
    return this.lock;
  }

  async audit(actor, action, payload = {}) {
    return this.update((data) => {
      data.auditLog.push({
        id: crypto.randomUUID(),
        actor,
        action,
        payload,
        createdAt: new Date().toISOString(),
      });
    });
  }
}
