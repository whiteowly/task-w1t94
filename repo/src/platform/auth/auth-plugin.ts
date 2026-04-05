import fp from 'fastify-plugin';

import { unauthorized } from '../errors/app-error';

import { getSessionContext } from './session';

const parseBearer = (authorization?: string): string | null => {
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return null;
  }

  return token;
};

export const authPlugin = fp(async (fastify) => {
  fastify.decorateRequest('auth', null);

  fastify.decorate('authenticate', async (request) => {
    const token = parseBearer(request.headers.authorization);
    if (!token) {
      throw unauthorized();
    }

    const context = await getSessionContext(fastify.appDb, token);
    if (!context) {
      throw unauthorized('Invalid or expired session');
    }

    request.auth = context;
  });
});
