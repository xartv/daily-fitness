import { PrismaPg } from "@prisma/adapter-pg";
import fp from "fastify-plugin";
import { env } from "../config/env";
import { PrismaClient } from "../generated/prisma/client";

export default fp(
  async (app) => {
    const connectionString = env.DATABASE_URL;
    const adapter = new PrismaPg({ connectionString });
    const client = new PrismaClient({ adapter });

    app.decorate("prisma", client);

    app.addHook("onClose", async () => {
      await client.$disconnect();
    });
  },
  { name: "prisma" },
);

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}
