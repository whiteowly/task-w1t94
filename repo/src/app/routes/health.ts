import type { FastifyInstance } from 'fastify';

export const registerHealthRoutes = async (fastify: FastifyInstance) => {
  fastify.get('/health/live', async (request, reply) => {
    return reply.send({
      status: 'ok',
      correlationId: request.id
    });
  });

  fastify.get('/health/ready', async (request, reply) => {
    fastify.appDb.sqlite.prepare('SELECT 1').get();

    return reply.send({
      status: 'ready',
      correlationId: request.id
    });
  });
};
