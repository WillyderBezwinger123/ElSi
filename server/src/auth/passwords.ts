import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2 defaults: Argon2id, m=19456 KiB, t=2, p=1 (OWASP recommendation).
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/** Burns the same time as a real verification, so unknown emails are not distinguishable. */
export async function verifyDummy(password: string): Promise<void> {
  dummyHash ??= hash('elsi-dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}
