import type { FastifyServerOptions } from 'fastify';

import type { AppConfig } from '../config';

const defaultRedactions = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'body.password',
  'body.token',
  'body.reference',
  'body.referenceText',
  'body.personalNote',
  'body.note',
  '*.password',
  '*.token',
  '*.reference',
  '*.referenceText',
  '*.personalNote',
  '*.note',
  '*.ciphertext',
  '*.authTag',
  '*.iv'
];

export const createLogger = (config: AppConfig) => {
  const options: NonNullable<FastifyServerOptions['logger']> = {
    level: config.logLevel,
    redact: {
      paths: defaultRedactions,
      censor: '[REDACTED]'
    },
    base: undefined
  };

  if (config.nodeEnv === 'development') {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: false,
        translateTime: 'SYS:standard'
      }
    };
  }

  return options;
};
