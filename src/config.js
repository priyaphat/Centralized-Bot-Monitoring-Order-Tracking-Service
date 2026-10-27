import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://oxide:oxide_dev@localhost:55432/oxide_monitor',
  simulatorUrl: process.env.BOT_SIMULATOR_URL || 'http://localhost:8788',
  heartbeatTimeoutSeconds: Number(process.env.HEARTBEAT_TIMEOUT_SECONDS || 20),
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 5000),
  commandRetries: Number(process.env.COMMAND_RETRIES || 3)
};
