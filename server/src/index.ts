import { mkdir } from 'node:fs/promises';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createDb, migrate } from './db/index.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const db = await createDb(config.databaseUrl);
  await migrate(db);
  await mkdir(config.filesDir, { recursive: true });

  const app = buildApp({ db, config });
  app.addHook('onClose', async () => db.close());
  if (config.databaseUrl === 'pglite://memory') {
    app.log.warn('DATABASE_URL=pglite://memory: data is lost when the server stops');
  }

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error(err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
