import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().min(1).max(65535).int().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.url(),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error(z.prettifyError(result.error));
  process.exit(1);
}

export const env = result.data;
