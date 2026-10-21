import helmet from "@fastify/helmet";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import errorHandler from "./plugins/error-handler";
import prisma from "./plugins/prisma";
import { env, isDev } from "./config/env";
import routes from "./routes";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(isDev && {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
          },
        },
      }),
    },
  });

  // Zod schemas in route definitions validate requests and serialize responses
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(helmet);
  app.register(prisma);
  app.register(errorHandler);

  // Routes go last so they inherit everything registered above
  app.register(routes, { prefix: "/api" });

  return app;
}
