import { Buffer } from 'node:buffer';
import { z } from 'zod';

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().min(1).default('./data/app.db'),
    EXPORT_DIR: z.string().min(1).default('./data/exports'),
    FACILITY_TIMEZONE: z.string().min(1),
    APP_ENCRYPTION_KEY_B64: z.string().min(1),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 7).default(12),
    SCHEDULER_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true')
  })
  .superRefine((raw, ctx) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: raw.FACILITY_TIMEZONE });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid FACILITY_TIMEZONE: ${raw.FACILITY_TIMEZONE}`,
        path: ['FACILITY_TIMEZONE']
      });
    }

    try {
      const key = Buffer.from(raw.APP_ENCRYPTION_KEY_B64, 'base64');
      if (key.length !== 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'APP_ENCRYPTION_KEY_B64 must decode to exactly 32 bytes (AES-256-GCM)',
          path: ['APP_ENCRYPTION_KEY_B64']
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'APP_ENCRYPTION_KEY_B64 must be valid base64',
        path: ['APP_ENCRYPTION_KEY_B64']
      });
    }
  });

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  databaseUrl: string;
  exportDir: string;
  facilityTimezone: string;
  encryptionKey: Buffer;
  sessionTtlHours: number;
  schedulerEnabled: boolean;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }

  const value = parsed.data;

  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    databaseUrl: value.DATABASE_URL,
    exportDir: value.EXPORT_DIR,
    facilityTimezone: value.FACILITY_TIMEZONE,
    encryptionKey: Buffer.from(value.APP_ENCRYPTION_KEY_B64, 'base64'),
    sessionTtlHours: value.SESSION_TTL_HOURS,
    schedulerEnabled: value.SCHEDULER_ENABLED
  };
};
