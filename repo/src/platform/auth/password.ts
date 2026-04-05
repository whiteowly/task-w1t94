import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

export const hashPassword = (plainTextPassword: string): string => {
  const salt = randomBytes(16);
  const hash = scryptSync(plainTextPassword, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
};

export const verifyPassword = (plainTextPassword: string, storedHash: string): boolean => {
  const [algorithm, saltB64, expectedHashB64] = storedHash.split('$');
  if (algorithm !== 'scrypt' || !saltB64 || !expectedHashB64) {
    return false;
  }

  const salt = Buffer.from(saltB64, 'base64');
  const expectedHash = Buffer.from(expectedHashB64, 'base64');
  const computed = scryptSync(plainTextPassword, salt, expectedHash.length);

  return timingSafeEqual(expectedHash, computed);
};
