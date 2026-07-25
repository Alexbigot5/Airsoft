import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env as AppEnv } from '../src/types';

// `env` from "cloudflare:test" is typed as Cloudflare.Env, so the app's own
// bindings plus the migrations handed to the pool are declared here.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
