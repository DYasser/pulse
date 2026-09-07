import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * Prisma 7 no longer reads the connection URL from schema.prisma, so migrations and
 * introspection get it from here while the running application supplies its own
 * adapter. Both read DATABASE_URL, so there is still one source of truth.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
