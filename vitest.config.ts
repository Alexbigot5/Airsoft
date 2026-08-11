import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  // Tests run against the real migrations rather than a hand-maintained test
  // schema, so a migration that breaks a constraint fails the suite.
  const migrations = await readD1Migrations(path.join(here, 'migrations'));

  return {
    plugins: [
      cloudflareTest({
        main: './src/index.ts',
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_TOKEN: 'test-staff-token',
            // Pinned empty so the suite starts from "no mail transport"
            // whatever a developer happens to have in .dev.vars. The contact
            // tests that need a working one set it themselves.
            RESEND_API_KEY: '',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
