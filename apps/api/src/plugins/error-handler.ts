import fp from "fastify-plugin";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";

type ClientError = Error & { statusCode: number; code: string };

// Fastify 5 types the handler's error as unknown, so narrow it by hand
function isClientError(error: unknown): error is ClientError {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    "code" in error &&
    typeof error.code === "string"
  );
}

export default fp(
  async (app) => {
    app.setErrorHandler((error, request, reply) => {
      if (hasZodFastifySchemaValidationErrors(error)) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            details: error.validation.map(({ instancePath, message }) => ({
              path: instancePath,
              message,
            })),
          },
        });
      }

      // Response did not match its schema: a bug on our side, never the client's fault
      if (isResponseSerializationError(error)) {
        request.log.error(error);
        return reply.status(500).send({
          error: { code: "INTERNAL_ERROR", message: "Internal server error" },
        });
      }

      // Client errors raised by Fastify itself (malformed JSON, payload too large, ...)
      if (isClientError(error)) {
        return reply.status(error.statusCode).send({
          error: { code: error.code, message: error.message },
        });
      }

      // Never leak internals (stack traces, Prisma messages) to the client
      request.log.error(error);
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      });
    });

    app.setNotFoundHandler((request, reply) => {
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: `Route ${request.method} ${request.url} not found`,
        },
      });
    });
  },
  { name: "error-handler" },
);
