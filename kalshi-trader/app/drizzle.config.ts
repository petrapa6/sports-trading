import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration: `npm run db:generate` writes SQL migrations to ./migrations from
 * src/db/schema.ts; `npm run db:studio` opens the database at DB_PATH (default ./.local/trader.db).
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env['DB_PATH'] || './.local/trader.db' },
});
