import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type EncryptedValue = {
  keyVersion: string;
  iv: string;
  ciphertext: string;
  authTag: string;
};

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export const encryptSensitive = (
  plaintext: string,
  key: Buffer,
  aad: string,
  keyVersion = 'v1'
): EncryptedValue => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    keyVersion,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64')
  };
};

export const decryptSensitive = (payload: EncryptedValue, key: Buffer, aad: string): string => {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final()
  ]);

  return plaintext.toString('utf8');
};
