// Loads .env.test before any test file imports PrismaService, so the suite always
// talks to pulse_test and can never truncate the development database.
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '..', '.env.test'), override: true });
