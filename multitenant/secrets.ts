import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// #region secrets
/**
 * Per-tenant secrets (a tenant's own provider key, OAuth tokens) encrypted in
 * the application with AES-256-GCM. The tenant id is bound as additional
 * authenticated data: a ciphertext copied into another tenant's row fails to
 * decrypt instead of quietly working for the wrong customer.
 *
 * The key comes from a secret manager or KMS, never from the same database
 * as the ciphertext. Format: v1.<iv>.<tag>.<ciphertext>, base64url.
 */
export function encryptForTenant(plaintext: string, tenantId: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`tenant:${tenantId}`));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decryptForTenant(token: string, tenantId: string, key: Buffer): string {
  const [v, iv, tag, ct] = token.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(`tenant:${tenantId}`));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
// #endregion secrets
