export type ApiGatewayRequest = {
  body: string | null;
  headers: Record<string, string | undefined>;
  pathParameters?: Record<string, string | undefined>;
  requestContext: {
    requestId: string;
    http: { sourceIp: string };
  };
};

export type ApiGatewayResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

export function jsonResponse(
  statusCode: number,
  body: Record<string, unknown>,
): ApiGatewayResponse {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
    body: JSON.stringify(body),
  };
}

export function parseJsonObject(body: string | null): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const value = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function bearerToken(headers: Record<string, string | undefined>): string | null {
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "authorization",
  )?.[1];
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function normalizedHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key.toLowerCase(), value]),
  );
}
