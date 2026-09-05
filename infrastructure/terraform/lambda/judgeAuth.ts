import { AwsDynamoDocument } from "../../../src/server/aws/AwsDynamoDocument";
import { DynamoFixedWindowRateLimiter } from "../../../src/server/judge/aws/dynamo";
import { Pbkdf2AccessCodeVerifier } from "../../../src/server/judge/backend/accessCode";
import { SecretsManagerAccessCodeSecretStore } from "../../../src/server/judge/aws/secrets";
import type { SecretsManagerPort } from "../../../src/server/judge/aws/secrets";
import { DynamoJudgeAuthStore, JudgeAuthService } from "../../../src/server/judge-auth";

/**
 * Shared composition for the two judge-auth Lambdas.
 *
 * Both the login endpoint and the API Gateway authorizer need the same
 * service; building it once here keeps the access-code secret id, the table
 * name and the TTL from drifting between them.
 */

export function required(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    // Fail closed at cold start rather than authenticating wrongly.
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

export function optional(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/**
 * Secrets Manager through the repository's own narrow port.
 *
 * Imported lazily so the authorizer, which is on the hot path of every API
 * call, does not pay for the SDK client until it actually reads the secret.
 */
let secretsClientPromise: Promise<SecretsManagerPort> | null = null;

function secretsClient(): Promise<SecretsManagerPort> {
  secretsClientPromise ??= import("@aws-sdk/client-secrets-manager").then((sdk) => {
    const client = new sdk.SecretsManagerClient({});
    return {
      async execute(command) {
        const response = await client.send(
          new sdk.GetSecretValueCommand({ SecretId: command.secretId }),
        );
        return { secretString: response.SecretString };
      },
    } satisfies SecretsManagerPort;
  });
  return secretsClientPromise;
}

/**
 * Reads the PBKDF2 digest on demand, so a rotated secret takes effect without
 * a redeploy and a cold start never fails because the secret was unreachable.
 */
class LazySecretStore {
  constructor(private readonly secretId: string) {}

  async getSecret() {
    return new SecretsManagerAccessCodeSecretStore(
      await secretsClient(),
      this.secretId,
    ).getSecret();
  }
}

export function buildJudgeAuthService(): JudgeAuthService {
  const tableName = required("PROCUREMENT_TABLE");
  const dynamo = new AwsDynamoDocument({ region: optional("AWS_REGION") || undefined });

  return new JudgeAuthService({
    enabled: process.env.JUDGE_AUTH_ENABLED === "true",
    verifier: new Pbkdf2AccessCodeVerifier(
      new LazySecretStore(required("JUDGE_ACCESS_CODE_SECRET_ID")),
    ),
    store: new DynamoJudgeAuthStore(dynamo, tableName),
    /*
     * Sign-in attempts are limited per source IP, the only thing available
     * before a caller is authenticated. Without it the access code could be
     * ground down for free.
     */
    rateLimiter: new DynamoFixedWindowRateLimiter(
      dynamo,
      tableName,
      Number.parseInt(optional("LOGIN_ATTEMPTS_PER_WINDOW") || "10", 10),
      15 * 60 * 1000,
    ),
    sessionTtlMs: Number.parseInt(optional("JUDGE_SESSION_TTL_MS") || "1800000", 10),
  });
}
