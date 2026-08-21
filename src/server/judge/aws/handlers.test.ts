import { describe, expect, it, vi } from "vitest";
import { JudgeBackendError, type JudgeBackendService, type JudgeWebhookService } from "../backend";
import { createJudgeHandlers, type ApiGatewayRequest } from ".";

function event(overrides: Partial<ApiGatewayRequest> = {}): ApiGatewayRequest {
  return {
    body: null,
    headers: {},
    requestContext: {
      requestId: "request-1",
      http: { sourceIp: "192.0.2.10" },
    },
    ...overrides,
  };
}

function stubs() {
  const backend = {
    createSession: vi.fn(),
    startManagerCall: vi.fn(),
  } as unknown as JudgeBackendService;
  const webhooks = {
    ingest: vi.fn(),
  } as unknown as JudgeWebhookService;
  return { backend, webhooks, handlers: createJudgeHandlers(backend, webhooks) };
}

describe("API Gateway Judge handlers", () => {
  it("rejects a malformed session request without calling the backend", async () => {
    const { backend, handlers } = stubs();

    const response = await handlers.createSession(event({ body: "{}" }));

    expect(response.statusCode).toBe(400);
    expect(backend.createSession).not.toHaveBeenCalled();
    expect(response.headers["Cache-Control"]).toBe("no-store");
  });

  it("hashes the requester IP before passing it to the rate limiter boundary", async () => {
    const { backend, handlers } = stubs();
    vi.mocked(backend.createSession).mockResolvedValue({
      sessionId: "session-1",
      sessionToken: "opaque-token",
      expiresAt: "2026-08-21T10:15:00Z",
      remainingCalls: 1,
      mode: "MOCK",
      runId: "judge-run-1",
      scenario: {
        organizationName: "Northstar Manufacturing",
        sku: "CF-220",
        requiredQuantity: 8,
        stockoutAt: "2026-08-28T12:00:00+02:00",
        rejectedOffers: [],
      },
    });

    const response = await handlers.createSession(
      event({ body: JSON.stringify({ accessCode: "judge-entered-code" }) }),
    );

    expect(response.statusCode).toBe(201);
    const [, requesterKey] = vi.mocked(backend.createSession).mock.calls[0];
    expect(requesterKey).toMatch(/^[a-f0-9]{64}$/);
    expect(requesterKey).not.toContain("192.0.2.10");
  });

  it("maps backend authorization failures without leaking the error message", async () => {
    const { backend, handlers } = stubs();
    vi.mocked(backend.createSession).mockRejectedValue(
      new JudgeBackendError("Internal authorization detail", "ACCESS_DENIED"),
    );

    const response = await handlers.createSession(
      event({ body: JSON.stringify({ accessCode: "wrong" }) }),
    );

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "ACCESS_DENIED" });
    expect(response.body).not.toContain("Internal authorization detail");
  });

  it("requires bearer session, explicit consent and a supported locale", async () => {
    const { backend, handlers } = stubs();

    const response = await handlers.startManagerCall(
      event({
        pathParameters: { sessionId: "session-1" },
        headers: { Authorization: "Bearer opaque-token" },
        body: JSON.stringify({
          runId: "run-1",
          phoneE164: "+48500100200",
          locale: "es-ES",
          explicitConsent: false,
          idempotencyKey: "key-1",
        }),
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(backend.startManagerCall).not.toHaveBeenCalled();
  });

  it("maps a completed manager call to HTTP 200", async () => {
    const { backend, handlers } = stubs();
    vi.mocked(backend.startManagerCall).mockResolvedValue({
      runId: "run-1",
      callTaskId: "call-1",
      status: "COMPLETED",
      runtime: "MOCK",
    });

    const response = await handlers.startManagerCall(
      event({
        pathParameters: { sessionId: "session-1" },
        headers: { authorization: "Bearer opaque-token" },
        body: JSON.stringify({
          runId: "run-1",
          phoneE164: "+48500100200",
          locale: "pl-PL",
          explicitConsent: true,
          idempotencyKey: "key-1",
        }),
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(backend.startManagerCall).toHaveBeenCalledWith(
      "session-1",
      "opaque-token",
      expect.objectContaining({ explicitConsent: true }),
    );
  });

  it("passes the unchanged raw webhook body and normalized headers to verification", async () => {
    const { webhooks, handlers } = stubs();
    vi.mocked(webhooks.ingest).mockResolvedValue("DUPLICATE");
    const rawBody = "{\"eventId\":\"event-1\"}";

    const response = await handlers.ingestWebhook(
      event({
        body: rawBody,
        headers: { "X-CALL-Signature": "signature" },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(webhooks.ingest).toHaveBeenCalledWith(rawBody, {
      "x-call-signature": "signature",
    });
  });
});
