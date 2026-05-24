import fs from "node:fs/promises";

const featureToStack = {
  kanban: "kanban",
  chatwoot: "chatwoot",
  n8n: "n8n",
  proxy: "proxy",
};

export async function buildManifest({ baseManifestPath, license }) {
  const manifest = JSON.parse(await fs.readFile(baseManifestPath, "utf8"));
  const features = new Set(license.features || []);
  const stacks = {};

  for (const feature of features) {
    const stackKey = featureToStack[feature];
    if (stackKey && manifest.stacks?.[stackKey]) {
      stacks[stackKey] = manifest.stacks[stackKey];
    }
  }

  if (!stacks.kanban && manifest.stacks?.kanban) {
    stacks.kanban = manifest.stacks.kanban;
  }

  return {
    ...manifest,
    generatedAt: new Date().toISOString(),
    license: {
      mode: "central",
      customerId: license.customerId,
      installationId: license.installationId,
      installKeyId: license.installKeyId,
      expiresAt: license.expiresAt || null,
      features: [...features],
    },
    stacks,
  };
}
