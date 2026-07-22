// Shared backend types. Kept tiny and dependency-light so route modules can
// describe the injected dependencies (the db layer + config) without importing
// concrete singletons.

import type * as DbModule from './db';
import type { config } from './config';

export type Db = typeof DbModule;
export type AppConfig = typeof config;

// Dependencies injected into each route module (handoff 4.4: inject shared
// dependencies rather than importing global singletons).
export interface Deps {
  db: Db;
  config: AppConfig;
}
