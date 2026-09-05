import { buildJudgeAuthService } from "./judgeAuth";
import type { JudgeAuthService } from "../../../src/server/judge-auth";

/**
 * API Gateway HTTP API Lambda authorizer, simple-response format.
 *
 * Resolves the opaque bearer token to a judge identity and puts it in the
 * authorizer context. `voiceSessionHandler` reads `authorizer.lambda.judgeId`
 * and nothing else, so this function is the single place identity is decided.
 *
 * `isAuthorized: false` is returned for every failure, including an internal
 * one. Throwing would surface a 500 that a caller could use to distinguish a
 * broken backend from a rejected token; failing closed tells them nothing.
 */

type AuthorizerEvent = {
  headers?: Record<string, string | undefined>;
  identitySource?: string[];
};

type AuthorizerResponse = {
  isAuthorized: boolean;
  context?: Record<string, string>;
};

/** Header names arrive lower-cased on HTTP APIs, but not on every path. */
export function authorizationHeader(event: AuthorizerEvent): string | undefined {
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === "authorization" && typeof value === "string") return value;
  }
  /*
   * identitySource carries the same header when API Gateway is configured with
   * one, and is present even where the headers map has been trimmed.
   */
  const fromIdentity = event.identitySource?.[0];
  return typeof fromIdentity === "string" ? fromIdentity : undefined;
}

const DENIED: AuthorizerResponse = { isAuthorized: false };

let service: JudgeAuthService | null = null;

export function createHandler(overrides: { service?: JudgeAuthService } = {}) {
  return async function judgeAuthorizerHandler(
    event: AuthorizerEvent,
  ): Promise<AuthorizerResponse> {
    try {
      service ??= buildJudgeAuthService();
      const result = await (overrides.service ?? service).authorize(
        authorizationHeader(event),
        new Date(),
      );

      if (result.status === "DENIED") {
        // The reason is logged for operators; the caller only ever sees a 401.
        console.log(JSON.stringify({ event: "JUDGE_AUTHORIZER_DENIED", reason: result.reason }));
        return DENIED;
      }

      /*
       * The context is what the downstream Lambda trusts. It carries the
       * server-minted judge id only - no token, no hash, nothing a downstream
       * handler could replay.
       */
      return {
        isAuthorized: true,
        context: { judgeId: result.judgeId },
      };
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "JUDGE_AUTHORIZER_ERROR",
          message: error instanceof Error ? error.message : "unknown error",
        }),
      );
      return DENIED;
    }
  };
}

export const handler = createHandler();
