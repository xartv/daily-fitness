import { errorResponseSchema } from "@daily-fitness/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

const health: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/health",
    {
      schema: {
        response: {
          200: healthResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async function (request, reply) {
      try {
        await app.prisma.$queryRaw`SELECT 1`;
        return { status: "ok" as const };
      } catch (error) {
        request.log.error(error, "health check failed");
        return reply.code(503).send({
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      }
    },
  );
};

export default health;
