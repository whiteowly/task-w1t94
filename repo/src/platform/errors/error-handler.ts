import type { FastifyInstance } from 'fastify';

import { ZodError } from 'zod';

import { AppError } from './app-error';

export const registerErrorHandler = (fastify: FastifyInstance) => {
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details ?? null,
          correlationId: request.id
        }
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.flatten(),
          correlationId: request.id
        }
      });
    }

    const maybeValidationError = error as { validation?: unknown; message?: string };

    if (maybeValidationError.validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: maybeValidationError.message ?? 'Request validation failed',
          details: maybeValidationError.validation,
          correlationId: request.id
        }
      });
    }

    request.log.error({ err: error }, 'Unhandled application error');

    return reply.status(500).send({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        details: null,
        correlationId: request.id
      }
    });
  });
};
