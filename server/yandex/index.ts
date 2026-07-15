import { createHash } from "node:crypto";
import { z } from "zod";
import { criteriaSchema, discoverSuppliers, DiscoveryError, verifyAccessCode } from "../../app/lib/discovery";

type ApiGatewayEvent = {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  requestContext?: { identity?: { sourceIp?: string }; http?: { sourceIp?: string } };
};

const allowedOrigins = () => (process.env.ALLOWED_ORIGINS || "https://donmiguel66.github.io,http://localhost:3000,http://localhost:5173")
  .split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);

function header(event: ApiGatewayEvent, name: string): string {
  const found = Object.entries(event.headers || {}).find(([key]) => key.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"));
  return found?.[1] || "";
}

function response(statusCode: number, body: unknown, origin = "") {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST,OPTIONS,GET";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  return { statusCode, headers, body: JSON.stringify(body), isBase64Encoded: false };
}

export async function handler(event: ApiGatewayEvent) {
  const method = (event.httpMethod || "GET").toUpperCase();
  const rawOrigin = header(event, "origin").replace(/\/$/, "");
  const origin = allowedOrigins().includes(rawOrigin) ? rawOrigin : "";
  if (rawOrigin && !origin) return response(403, { error: "Источник запроса не разрешён." });
  if (method === "OPTIONS") return response(204, {}, origin);
  if (method === "GET") return response(200, {
    status: "ok",
    provider: "yandex",
    liveSearchAvailable: Boolean(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID),
  }, origin);
  if (method !== "POST") return response(405, { error: "Метод не поддерживается." }, origin);

  try {
    const rawBody = event.body || "{}";
    const decoded = event.isBase64Encoded ? Buffer.from(rawBody, "base64").toString("utf8") : rawBody;
    const body = JSON.parse(decoded) as { action?: unknown; criteria?: unknown; accessCode?: unknown };
    const accessCode = typeof body.accessCode === "string" ? body.accessCode : "";
    if (body.action === "verify-access") {
      verifyAccessCode(accessCode);
      return response(200, { authorized: true }, origin);
    }
    const criteria = criteriaSchema.parse(body.criteria);
    const sourceIp = event.requestContext?.http?.sourceIp || event.requestContext?.identity?.sourceIp || header(event, "x-forwarded-for").split(",")[0] || "anonymous";
    const clientId = createHash("sha256").update(sourceIp.trim()).digest("hex").slice(0, 20);
    return response(200, await discoverSuppliers({ criteria, clientId, accessCode }), origin);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) return response(400, { error: "Параметры поиска некорректны." }, origin);
    if (error instanceof DiscoveryError) return response(error.status, { error: error.message }, origin);
    return response(500, { error: "Не удалось выполнить внешний поиск." }, origin);
  }
}
