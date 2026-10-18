import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { STATUS_CODES } from "node:http";

type ClientError = Error & { statusCode: number; code?: string };

// Fastify 5 types the handler's error as unknown, so narrow it by hand
function isClientError(error: unknown): error is ClientError {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  );
}

function formatStatusCode(statusName: string | undefined): string {
  if (!statusName) {
    return "CLIENT_ERROR";
  }

  return statusName.toUpperCase().split(" ").join("_");
}

function getClientErrorCode(error: ClientError): string {
  return typeof error.code === "string"
    ? error.code
    : formatStatusCode(STATUS_CODES[error.statusCode]);
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

      // Any 4xx error (from Fastify, plugins or our own code) is safe to pass through
      // as is; errors without a string code get a generic one so the format stays stable
      if (isClientError(error)) {
        return reply.status(error.statusCode).send({
          error: {
            code: getClientErrorCode(error),
            message: error.message,
          },
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
