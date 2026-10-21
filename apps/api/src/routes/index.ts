import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import health from "./health.routes";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.register(health);
};

export default routes;
