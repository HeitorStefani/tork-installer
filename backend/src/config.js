export const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: process.env.DATABASE_URL || "",
  apiKey: process.env.KANBAN_API_KEY || "",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:8080",
  chatwootBaseUrl: process.env.CHATWOOT_BASE_URL || "",
  chatwootApiToken: process.env.CHATWOOT_API_TOKEN || "",
  chatwootDatabaseUrl: process.env.CHATWOOT_DATABASE_URL || "",
  chatwootStoragePath: process.env.CHATWOOT_STORAGE_PATH || "/chatwoot-storage",
  chatwootWebhookSecret: process.env.CHATWOOT_WEBHOOK_SECRET || "",
  chatwootAssigneeSyncSeconds: Number(process.env.CHATWOOT_ASSIGNEE_SYNC_SECONDS || 5),
  defaultAccountId: Number(process.env.DEFAULT_ACCOUNT_ID || 1),
  defaultBoardName: process.env.DEFAULT_BOARD_NAME || "Atendimento IA",
  followUpAfterHours: Number(process.env.FOLLOW_UP_AFTER_HOURS || 24),
  lostAfterAttempts: Number(process.env.LOST_AFTER_ATTEMPTS || 2),
  maxJsonBodyBytes: Number(process.env.MAX_JSON_BODY_BYTES || 262144),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  rateLimitMaxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 600),
  corsOrigin: process.env.CORS_ORIGIN || "*",
};

export function requireConfig() {
  const missing = [];

  if (!config.databaseUrl) missing.push("DATABASE_URL");
  if (!config.apiKey) missing.push("KANBAN_API_KEY");

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
