import { describe, expect, it } from "vitest";
import {
  SecretsManagerAccessCodeSecretStore,
  type SecretsManagerPort,
} from ".";

describe("SecretsManagerAccessCodeSecretStore", () => {
  it("loads only the expected PBKDF2 secret schema", async () => {
    const client: SecretsManagerPort = {
      async execute() {
        return {
          secretString: JSON.stringify({
            algorithm: "PBKDF2-SHA256",
            saltBase64: "AQIDBAUGBwgJCgsMDQ4PEA==",
            derivedKeyBase64: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=",
            iterations: 150_000,
          }),
        };
      },
    };
    const store = new SecretsManagerAccessCodeSecretStore(
      client,
      "stockguard/judge-access-code",
    );

    await expect(store.getSecret()).resolves.toMatchObject({
      algorithm: "PBKDF2-SHA256",
      iterations: 150_000,
    });
  });

  it("fails closed for a plaintext or weak secret", async () => {
    const client: SecretsManagerPort = {
      async execute() {
        return {
          secretString: JSON.stringify({
            accessCode: "plaintext-code",
            iterations: 1,
          }),
        };
      },
    };
    const store = new SecretsManagerAccessCodeSecretStore(client, "secret-id");

    await expect(store.getSecret()).rejects.toThrow(
      "does not match the required PBKDF2 schema",
    );
  });

  it("fails closed when Secrets Manager returns malformed JSON", async () => {
    const client: SecretsManagerPort = {
      async execute() {
        return { secretString: "not-json" };
      },
    };
    const store = new SecretsManagerAccessCodeSecretStore(client, "secret-id");

    await expect(store.getSecret()).rejects.toThrow("secret is malformed");
  });
});
