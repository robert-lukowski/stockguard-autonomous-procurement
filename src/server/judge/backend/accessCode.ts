import type { AccessCodeSecret, AccessCodeSecretPort } from "./types";

const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveKey(
  accessCode: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(accessCode),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export class Pbkdf2AccessCodeVerifier {
  constructor(private readonly secretStore: AccessCodeSecretPort) {}

  async verify(accessCode: string): Promise<boolean> {
    const secret = await this.secretStore.getSecret();
    if (
      secret.algorithm !== "PBKDF2-SHA256" ||
      secret.iterations < 100_000 ||
      accessCode.length === 0
    ) {
      return false;
    }
    const actual = await deriveKey(
      accessCode,
      base64ToBytes(secret.saltBase64),
      secret.iterations,
    );
    return constantTimeEqual(actual, base64ToBytes(secret.derivedKeyBase64));
  }
}

export async function createTestAccessCodeSecret(
  accessCode: string,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
  iterations = 100_000,
): Promise<AccessCodeSecret> {
  return {
    algorithm: "PBKDF2-SHA256",
    saltBase64: bytesToBase64(salt),
    derivedKeyBase64: bytesToBase64(await deriveKey(accessCode, salt, iterations)),
    iterations,
  };
}

export class StaticAccessCodeSecretStore implements AccessCodeSecretPort {
  constructor(private readonly secret: AccessCodeSecret) {}

  async getSecret(): Promise<AccessCodeSecret> {
    return structuredClone(this.secret);
  }
}
