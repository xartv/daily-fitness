import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "prisma/config";

// Locally variables come from .env; in Docker and CI there is no such file
// and they come from the process environment instead
const envFile = join(import.meta.dirname, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
