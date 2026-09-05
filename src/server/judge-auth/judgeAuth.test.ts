import { describe, expect, it } from "vitest";

import { InMemoryDynamoDocument } from "../aws/inMemoryDynamoDocument";
import { createTestAccessCodeSecret } from "../judge/backend/accessCode";
import { Pbkdf2AccessCodeVerifier } from "../judge/backend/accessCode";
import { StaticAccessCodeSecretStore } from "../judge/backend/accessCode";
import { sha256 } from "../../security";
import {
  DynamoJudgeAuthStore,
  InMemoryJudgeAuthStore,
  JudgeAuthService,
  bearerToken,
  type JudgeAuthStore,
  type JudgeLoginRateLimiter,
} from "./index";

const NOW = new Date("2026-09-05T09:00:00.000Z");
const ACCESS_CODE = "STOCKGUARD-DEVPOST-2026";

function allowAll(): JudgeLoginRateLimiter {
  return { async allow() { return true; } };
}

async function service(
  overrides: {
    enabled?: boolean;
    store?: JudgeAuthStore;
    rateLimiter?: JudgeLoginRateLimiter;
    accessCode?: string;
    verifyThrows?: boolean;
  } = {},
) {
  const secret = await createTestAccessCodeSecret(overrides.accessCode ?? ACCESS_CODE);
  let tokens = 0;
  let ids = 0;

  return new JudgeAuthService({
    enabled: overrides.enabled ?? true,
    verifier: overrides.verifyThrows
      ? { async verify() { throw new Error("secret unavailable"); } }
      : new Pbkdf2AccessCodeVerifier(new StaticAccessCodeSecretStore(secret)),
    store: overrides.store ?? new InMemoryJudgeAuthStore(),
    rateLimiter: overrides.rateLimiter ?? allowAll(),
    randomToken: () => {
      tokens += 1;
      return String(tokens).padStart(64, "0");
    },
    randomJudgeId: () => {
      ids += 1;
      return `judge-${String(ids).padStart(4, "0")}`;
    },
  });
}

describe("judge sign-in", () => {
  it("exchanges a correct access code for a short-lived opaque token", async () => {
    const auth = await service();

    const result = await auth.login(ACCESS_CODE, "ip#1", NOW);

    expect(result.status).toBe("AUTHENTICATED");
    if (result.status !== "AUTHENTICATED") throw new Error("expected a token");
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.expiresAt).toBe("2026-09-05T09:30:00.000Z");
  });

  it("rejects a wrong access code without saying why", async () => {
    const auth = await service();

    const result = await auth.login("WRONG-CODE", "ip#1", NOW);

    expect(result).toMatchObject({ status: "REJECTED", reason: "INVALID_ACCESS_CODE" });
    expect(JSON.stringify(result)).not.toContain(ACCESS_CODE);
  });

  it("rejects an empty code before touching the verifier", async () => {
    const auth = await service();

    for (const code of ["", "   "]) {
      expect(await auth.login(code, "ip#1", NOW)).toMatchObject({
        reason: "INVALID_ACCESS_CODE",
      });
    }
  });

  it("counts a wrong code against the rate limit", async () => {
    let calls = 0;
    const rateLimiter: JudgeLoginRateLimiter = {
      async allow() {
        calls += 1;
        return calls <= 2;
      },
    };
    const auth = await service({ rateLimiter });

    await auth.login("WRONG", "ip#1", NOW);
    await auth.login("WRONG", "ip#1", NOW);
    const third = await auth.login(ACCESS_CODE, "ip#1", NOW);

    // Even the correct code is refused once the attempts are spent.
    expect(third).toMatchObject({ status: "REJECTED", reason: "RATE_LIMITED" });
  });

  it("fails closed when the access-code secret cannot be read", async () => {
    const auth = await service({ verifyThrows: true });

    expect(await auth.login(ACCESS_CODE, "ip#1", NOW)).toMatchObject({
      status: "REJECTED",
      reason: "UNAVAILABLE",
    });
  });

  it("refuses when judge sign-in is disabled", async () => {
    const auth = await service({ enabled: false });

    expect(await auth.login(ACCESS_CODE, "ip#1", NOW)).toMatchObject({
      status: "REJECTED",
      reason: "DISABLED",
    });
  });

  it("stores only the token hash, never the token", async () => {
    const store = new InMemoryJudgeAuthStore();
    const auth = await service({ store });

    const result = await auth.login(ACCESS_CODE, "ip#1", NOW);
    if (result.status !== "AUTHENTICATED") throw new Error("expected a token");

    const stored = await store.findByTokenHash(await sha256(result.token));
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(result.token);
  });

  it("mints a distinct judge id per sign-in", async () => {
    const auth = await service();

    const first = await auth.login(ACCESS_CODE, "ip#1", NOW);
    const second = await auth.login(ACCESS_CODE, "ip#2", NOW);
    if (first.status !== "AUTHENTICATED" || second.status !== "AUTHENTICATED") {
      throw new Error("expected two tokens");
    }

    expect(first.token).not.toBe(second.token);
  });
});

describe("authorizing a token", () => {
  it("resolves a valid bearer token to the judge id minted at sign-in", async () => {
    const store = new InMemoryJudgeAuthStore();
    const auth = await service({ store });
    const login = await auth.login(ACCESS_CODE, "ip#1", NOW);
    if (login.status !== "AUTHENTICATED") throw new Error("expected a token");

    const result = await auth.authorize(`Bearer ${login.token}`, NOW);

    expect(result).toMatchObject({ status: "AUTHORIZED", judgeId: "judge-0001" });
  });

  it("accepts the scheme case-insensitively", async () => {
    const auth = await service();
    const login = await auth.login(ACCESS_CODE, "ip#1", NOW);
    if (login.status !== "AUTHENTICATED") throw new Error("expected a token");

    for (const header of [`bearer ${login.token}`, `BEARER ${login.token}`]) {
      expect((await auth.authorize(header, NOW)).status).toBe("AUTHORIZED");
    }
  });

  it("denies a missing, malformed or foreign token", async () => {
    const auth = await service();
    const login = await auth.login(ACCESS_CODE, "ip#1", NOW);
    if (login.status !== "AUTHENTICATED") throw new Error("expected a token");

    const cases: Array<[string | undefined | null, string]> = [
      [undefined, "MISSING"],
      [null, "MISSING"],
      ["", "MALFORMED"],
      [login.token, "MALFORMED"],
      ["Bearer", "MALFORMED"],
      ["Bearer not-hex", "MALFORMED"],
      ["Basic dXNlcjpwYXNz", "MALFORMED"],
      [`Bearer ${"f".repeat(64)}`, "UNKNOWN"],
    ];

    for (const [header, reason] of cases) {
      expect(await auth.authorize(header, NOW)).toEqual({ status: "DENIED", reason });
    }
  });

  it("denies an expired token", async () => {
    const auth = await service();
    const login = await auth.login(ACCESS_CODE, "ip#1", NOW);
    if (login.status !== "AUTHENTICATED") throw new Error("expected a token");

    const later = new Date(NOW.getTime() + 31 * 60_000);
    expect(await auth.authorize(`Bearer ${login.token}`, later)).toEqual({
      status: "DENIED",
      reason: "EXPIRED",
    });
  });

  it("denies a revoked token", async () => {
    const store = new InMemoryJudgeAuthStore();
    const auth = await service({ store });
    const login = await auth.login(ACCESS_CODE, "ip#1", NOW);
    if (login.status !== "AUTHENTICATED") throw new Error("expected a token");

    await store.revoke(await sha256(login.token));

    expect(await auth.authorize(`Bearer ${login.token}`, NOW)).toEqual({
      status: "DENIED",
      reason: "REVOKED",
    });
  });
});

describe("bearer token parsing", () => {
  it("accepts only a 64-character hex token", () => {
    expect(bearerToken(`Bearer ${"a".repeat(64)}`)).toBe("a".repeat(64));
    expect(bearerToken(`Bearer ${"a".repeat(63)}`)).toBeNull();
    expect(bearerToken(`Bearer ${"A".repeat(64)}`)).toBeNull();
    expect(bearerToken(`Bearer ${"g".repeat(64)}`)).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

const stores: Array<[string, () => JudgeAuthStore]> = [
  ["InMemoryJudgeAuthStore", () => new InMemoryJudgeAuthStore()],
  [
    "DynamoJudgeAuthStore",
    () => new DynamoJudgeAuthStore(new InMemoryDynamoDocument(), "stockguard-procurement"),
  ],
];

describe.each(stores)("%s", (_name, build) => {
  const session = {
    judgeId: "judge-0001",
    tokenHash: "a".repeat(64),
    issuedAt: NOW.toISOString(),
    expiresAt: "2026-09-05T09:30:00.000Z",
    status: "ACTIVE" as const,
  };

  it("creates a session once per token hash", async () => {
    const store = build();

    expect(await store.create(session)).toBe("CREATED");
    expect(await store.create({ ...session, judgeId: "judge-other" })).toBe("DUPLICATE");
  });

  it("round-trips a session by token hash", async () => {
    const store = build();
    await store.create(session);

    expect(await store.findByTokenHash(session.tokenHash)).toEqual(session);
    expect(await store.findByTokenHash("b".repeat(64))).toBeNull();
  });

  it("revokes a session, and revoking an unknown one is a no-op", async () => {
    const store = build();
    await store.create(session);

    await store.revoke(session.tokenHash);
    await expect(store.revoke("b".repeat(64))).resolves.toBeUndefined();

    expect((await store.findByTokenHash(session.tokenHash))?.status).toBe("REVOKED");
  });
});
