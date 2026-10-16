import { buildApp } from "./app";
import { env } from "./config/env";

const app = await buildApp();

// Docker sends SIGTERM on stop, Ctrl+C sends SIGINT.
// app.close() stops accepting connections, waits for in-flight requests
// and runs every plugin's onClose hook (e.g. DB disconnect).
async function shutdown(signal: NodeJS.Signals) {
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
