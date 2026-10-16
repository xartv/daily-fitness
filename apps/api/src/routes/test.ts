import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get("/health", function (_, reply) {
    reply.send({ status: "ok" });
  });
};

export default routes;
