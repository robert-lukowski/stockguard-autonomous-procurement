import { describe, expect, it, vi } from "vitest";
import {
  JudgeModeBackendClient,
  JudgeModeBackendUnavailableError,
} from ".";

describe("JudgeModeBackendClient", () => {
  it("fails closed before transmitting an access code when no backend is configured", async () => {
    const fetchImplementation = vi.fn();
    const client = new JudgeModeBackendClient({ fetchImplementation });

    await expect(
      client.createSession({ accessCode: "entered-by-judge" }),
    ).rejects.toBeInstanceOf(JudgeModeBackendUnavailableError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("sends the code only to the configured backend session endpoint", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          sessionId: "session-1",
          sessionToken: "short-lived-token",
          expiresAt: "2026-08-21T10:15:00Z",
          remainingCalls: 1,
          mode: "LIVE_CALLE",
        }),
        { status: 200 },
      ),
    );
    const client = new JudgeModeBackendClient({
      baseUrl: "https://judge-api.example.test",
      fetchImplementation,
    });

    await client.createSession({ accessCode: "entered-by-judge" });

    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://judge-api.example.test/judge/sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
