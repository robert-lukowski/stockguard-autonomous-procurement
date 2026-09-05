/**
 * The judge's sign-in session, in the browser.
 *
 * The token lives in a module-scoped variable and nowhere else. Deliberately
 * NOT in localStorage, sessionStorage, a cookie or a URL parameter: it is a
 * bearer credential, and every one of those places either survives the tab, is
 * readable by other script on the origin, or ends up in a browser history and
 * a server log.
 *
 * The consequence is that a reload signs the judge out. That is the correct
 * trade for a demo credential with a thirty-minute life.
 */

export type JudgeSignInState =
  | { status: "signed-out" }
  | { status: "signing-in" }
  | { status: "signed-in"; expiresAt: string }
  | { status: "failed"; message: string };

type Session = { token: string; expiresAt: string };

let session: Session | null = null;

/** Cleared on sign-out and whenever a token is found to have expired. */
export function clearJudgeSession(): void {
  session = null;
}

export function judgeSessionExpiry(): string | null {
  return session?.expiresAt ?? null;
}

/**
 * The Authorization header for an authenticated call, or null.
 *
 * Expiry is checked here rather than only server-side so the portal can say
 * "signed out" instead of showing a confusing 401 from the voice endpoint.
 */
export function judgeAuthorizationHeader(now: Date = new Date()): string | null {
  if (!session) return null;
  if (Date.parse(session.expiresAt) <= now.getTime()) {
    session = null;
    return null;
  }
  return `Bearer ${session.token}`;
}

const failureMessages: Record<string, string> = {
  INVALID_ACCESS_CODE: "That access code was not accepted.",
  RATE_LIMITED: "Too many sign-in attempts. Try again in a few minutes.",
  DISABLED: "Judge sign-in is disabled in this deployment.",
  UNAVAILABLE: "Judge sign-in is temporarily unavailable.",
};

/**
 * Reads a sign-in response without trusting its shape.
 *
 * Anything unrecognized becomes a failure, never a signed-in state built from
 * a token the response did not actually contain.
 */
export function readSignInResponse(body: unknown): JudgeSignInState {
  if (typeof body !== "object" || body === null) {
    return { status: "failed", message: failureMessages.UNAVAILABLE };
  }
  const response = body as Record<string, unknown>;

  if (response.status === "REJECTED") {
    const reason = typeof response.reason === "string" ? response.reason : "";
    return {
      status: "failed",
      message: failureMessages[reason] ?? "Sign-in was refused.",
    };
  }
  if (
    response.status !== "AUTHENTICATED" ||
    typeof response.token !== "string" ||
    !/^[0-9a-f]{64}$/.test(response.token) ||
    typeof response.expiresAt !== "string"
  ) {
    return { status: "failed", message: failureMessages.UNAVAILABLE };
  }
  return { status: "signed-in", expiresAt: response.expiresAt };
}

/**
 * Exchanges an access code for a session token.
 *
 * The token is captured into module scope here and never returned to the
 * caller, so no component can accidentally render or store it.
 */
export async function signIn(
  endpoint: string,
  accessCode: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<JudgeSignInState> {
  let response: Response;
  try {
    response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessCode }),
    });
  } catch {
    return { status: "failed", message: "The sign-in service could not be reached." };
  }

  if (response.status === 429) {
    return { status: "failed", message: failureMessages.RATE_LIMITED };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "failed", message: failureMessages.UNAVAILABLE };
  }

  const state = readSignInResponse(body);
  if (state.status === "signed-in") {
    const parsed = body as { token: string; expiresAt: string };
    session = { token: parsed.token, expiresAt: parsed.expiresAt };
  }
  return state;
}
