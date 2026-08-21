import type { AccessCodeSecret, AccessCodeSecretPort } from "../backend";

export type SecretsManagerCommand = {
  operation: "GetSecretValue";
  secretId: string;
};

export interface SecretsManagerPort {
  execute(command: SecretsManagerCommand): Promise<{ secretString?: string }>;
}

function decodedByteLength(value: string): number | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  try {
    return atob(value).length;
  } catch {
    return null;
  }
}

function isAccessCodeSecret(value: unknown): value is AccessCodeSecret {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.algorithm === "PBKDF2-SHA256" &&
    typeof record.saltBase64 === "string" &&
    decodedByteLength(record.saltBase64) !== null &&
    (decodedByteLength(record.saltBase64) ?? 0) >= 16 &&
    typeof record.derivedKeyBase64 === "string" &&
    decodedByteLength(record.derivedKeyBase64) === 32 &&
    typeof record.iterations === "number" &&
    Number.isInteger(record.iterations) &&
    record.iterations >= 100_000
  );
}

export class SecretsManagerAccessCodeSecretStore implements AccessCodeSecretPort {
  constructor(
    private readonly client: SecretsManagerPort,
    private readonly secretId: string,
  ) {}

  async getSecret(): Promise<AccessCodeSecret> {
    const response = await this.client.execute({
      operation: "GetSecretValue",
      secretId: this.secretId,
    });
    if (!response.secretString) throw new Error("Judge access-code secret is unavailable");
    let value: unknown;
    try {
      value = JSON.parse(response.secretString);
    } catch {
      throw new Error("Judge access-code secret is malformed");
    }
    if (!isAccessCodeSecret(value)) {
      throw new Error("Judge access-code secret does not match the required PBKDF2 schema");
    }
    return structuredClone(value);
  }
}
