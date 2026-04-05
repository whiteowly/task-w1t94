import { buildServer } from './build-server';

const start = async () => {
  const fastify = await buildServer();

  await fastify.listen({
    host: fastify.appConfig.host,
    port: fastify.appConfig.port
  });

  if (fastify.scheduler) {
    await fastify.scheduler.start();
  }

  const shutdown = async (signal: string) => {
    fastify.log.info({ signal }, 'Received shutdown signal');
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
};

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
