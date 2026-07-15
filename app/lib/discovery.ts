import { z } from "zod";
import { createHash, timingSafeEqual } from "node:crypto";
import { categories } from "../data/categories";
import { russianRegions } from "../data/regions";
import type { SearchCriteria, Supplier } from "../types";
import { supplierMatches } from "./matching";
import { canonicalUrl, collectSupplierEvidence } from "./source-enrichment";
import { createYandexEnrichmentRequest, createYandexSearchRequest, createYandexStructureRequest, parseYandexResponse, parseYandexSearchResponse } from "./yandex";

const categoryValues = ["Все категории", ...categories] as const;

export const criteriaSchema = z.object({
  query: z.string().max(160).default(""),
  category: z.enum(categoryValues).default("Все категории"),
  region: z.enum(russianRegions),
  city: z.string().max(80).default(""),
  quantity: z.number().positive().max(1_000_000).optional(),
  quantityUnit: z.enum(["кг", "л", "шт", "упак"]).default("кг"),
  requiresCertificates: z.boolean().default(false),
  requiresDelivery: z.boolean().default(false),
  requiresPublishedPrice: z.boolean().default(false),
});

export class DiscoveryError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function verifyAccessCode(accessCode = "", env: NodeJS.ProcessEnv = process.env): void {
  const expected = env.ACCESS_CODE?.trim();
  if (!expected) return;
  const expectedHash = createHash("sha256").update(expected).digest();
  const providedHash = createHash("sha256").update(accessCode.trim()).digest();
  if (!timingSafeEqual(expectedHash, providedHash)) {
    throw new DiscoveryError(401, "Неверный код доступа.");
  }
}

type DiscoveryResponse = { suppliers: Supplier[]; provider: "yandex"; model: string; searchedAt: string; cached: boolean };
type CacheEntry = { expiresAt: number; value: DiscoveryResponse };

const cache = new Map<string, CacheEntry>();
const CACHE_SCHEMA_VERSION = "live-sources-v11-recall-and-normalization";
const clientRequests = new Map<string, number[]>();
let dailyWindow = "";
let dailyRequests = 0;
let lastClientCleanup = 0;

const numberEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Структурная строка в stdout → попадает в Yandex Cloud Logging.
// Не логируем код доступа, ключ или полный IP (clientId уже захэширован в функции).
function logTelemetry(env: NodeJS.ProcessEnv, entry: Record<string, unknown>) {
  if (env.NODE_ENV === "test") return;
  try { console.log(JSON.stringify({ log: "discovery", ts: new Date().toISOString(), ...entry })); }
  catch { /* телеметрия никогда не должна ломать запрос */ }
}

const normalizePlace = (value: string) => value.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[–—-]/g, " ").replace(/\s+/g, " ").trim();

// Канонический ключ кэша: регистр, пробелы и «ё» не создают отдельных записей,
// а порядок полей фиксирован массивом, поэтому одинаковые по смыслу запросы
// переиспользуют уже полученный ответ вместо повторного обращения к Yandex.
function cacheKeyFor(criteria: SearchCriteria): string {
  const canonical = [
    normalizePlace(criteria.query),
    criteria.category,
    normalizePlace(criteria.region),
    normalizePlace(criteria.city),
    criteria.quantity ?? "",
    criteria.quantityUnit,
    criteria.requiresCertificates ? 1 : 0,
    criteria.requiresDelivery ? 1 : 0,
    criteria.requiresPublishedPrice ? 1 : 0,
  ];
  return `${CACHE_SCHEMA_VERSION}:${JSON.stringify(canonical)}`;
}

function servesRequestedRegion(supplier: Supplier, region: string): boolean {
  const requested = normalizePlace(region);
  return [supplier.region, ...supplier.serviceAreas].some((area) => normalizePlace(area) === requested || normalizePlace(area) === "вся россия");
}

function checkLimits(clientId: string, now: number, hourlyLimit: number, dailyLimit: number) {
  const hourAgo = now - 3_600_000;
  if (now - lastClientCleanup > 600_000) {
    for (const [key, timestamps] of clientRequests) {
      const active = timestamps.filter((timestamp) => timestamp > hourAgo);
      if (active.length) clientRequests.set(key, active);
      else clientRequests.delete(key);
    }
    lastClientCleanup = now;
  }
  const recent = (clientRequests.get(clientId) || []).filter((timestamp) => timestamp > hourAgo);
  if (recent.length >= hourlyLimit) throw new DiscoveryError(429, "Лимит внешнего поиска исчерпан. Попробуйте позже или измените запрос после паузы.");
  const day = new Date(now).toISOString().slice(0, 10);
  if (dailyWindow !== day) { dailyWindow = day; dailyRequests = 0; }
  if (dailyRequests >= dailyLimit) throw new DiscoveryError(429, "Дневной бюджет поиска исчерпан. Попробуйте снова завтра.");
  recent.push(now);
  clientRequests.set(clientId, recent);
  dailyRequests += 1;
}

export async function discoverSuppliers({
  criteria,
  clientId,
  accessCode = "",
  env = process.env,
  fetchImpl = fetch,
  now = Date.now(),
}: {
  criteria: SearchCriteria;
  clientId: string;
  accessCode?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<DiscoveryResponse> {
  const startedReal = Date.now();
  const apiKey = env.YANDEX_API_KEY;
  const folderId = env.YANDEX_FOLDER_ID;
  if (!apiKey || !folderId) throw new DiscoveryError(503, "Поиск временно недоступен: сервер не настроен.");
  // Простой общий код доступа: включается только если задан ACCESS_CODE в окружении сервера.
  // Локально без ACCESS_CODE поиск работает как прежде.
  try {
    verifyAccessCode(accessCode, env);
  } catch (error) {
    logTelemetry(env, { evt: "denied", reason: "access_code", region: criteria.region, category: criteria.category });
    throw error;
  }
  const model = env.YANDEX_MODEL || "yandexgpt-lite";
  const cacheKey = cacheKeyFor(criteria);
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    logTelemetry(env, { evt: "cache_hit", clientId, region: criteria.region, category: criteria.category, query: criteria.query.slice(0, 80), count: cached.value.suppliers.length });
    return { ...cached.value, cached: true };
  }
  if (cache.size > 100) {
    for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
    if (cache.size > 100) cache.delete(cache.keys().next().value as string);
  }
  try {
    checkLimits(clientId || "anonymous", now, numberEnv(env.DISCOVERY_RATE_LIMIT_PER_HOUR, 6), numberEnv(env.DISCOVERY_DAILY_LIMIT, 100));
  } catch (error) {
    logTelemetry(env, { evt: "denied", reason: "rate_limit", clientId, region: criteria.region, category: criteria.category });
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50_000);
  const callYandex = async (body: unknown, stage: "search" | "structure" | "enrich"): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl("https://ai.api.cloud.yandex.net/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Api-Key ${apiKey}`,
          "OpenAI-Project": folderId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new DiscoveryError(504, "Внешний поиск не успел ответить. Попробуйте ещё раз позже.");
      throw new DiscoveryError(502, "Сервис внешнего поиска временно недоступен.");
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new DiscoveryError(502, "Yandex вернул ответ в неизвестном формате."); }
    const provider = payload && typeof payload === "object" ? payload as { status?: string; error?: unknown; message?: string; traceId?: string } : {};
    if (!response.ok || provider.status === "failed" || provider.error) {
      if (env.NODE_ENV !== "test") console.warn("[Yandex discovery]", { stage, httpStatus: response.status, ...provider });
      if (response.status === 429) throw new DiscoveryError(429, "Yandex временно ограничил число запросов. Попробуйте позже.");
      if (response.status === 401 || response.status === 403) throw new DiscoveryError(503, "Yandex AI Studio отклонил доступ. Проверьте API-ключ, folder ID и роли сервисного аккаунта.");
      if (!response.ok && response.status === 400) throw new DiscoveryError(502, "Yandex отклонил параметры внешнего поиска. Подробности записаны в серверный лог.");
      throw new DiscoveryError(502, stage === "search" ? "Yandex не смог выполнить веб-поиск." : stage === "enrich" ? "Yandex не смог обогатить найденные карточки." : "Yandex не смог структурировать результаты поиска.");
    }
    return payload;
  };
  let parsed: ReturnType<typeof parseYandexResponse>;
  try {
    const searchPayload = await callYandex(createYandexSearchRequest(criteria, folderId, model), "search");
    const search = parseYandexSearchResponse(searchPayload);
    const structureRequest = createYandexStructureRequest(criteria, folderId, model, search.text, search.citations);
    const structurePayload = await callYandex(structureRequest, "structure");
    try {
      parsed = parseYandexResponse(structurePayload, new Date(now), search.citations);
    } catch {
      logTelemetry(env, { evt: "structure_retry", clientId, region: criteria.region, category: criteria.category });
      const retryPayload = await callYandex(structureRequest, "structure");
      parsed = parseYandexResponse(retryPayload, new Date(now), search.citations);
    }
    parsed = { ...parsed, suppliers: parsed.suppliers.filter((supplier) => servesRequestedRegion(supplier, criteria.region)) };
    const maxLinks = Math.max(0, Math.min(3, numberEnv(env.DISCOVERY_ENRICHMENT_LINKS_PER_SUPPLIER, 2)));
    const evidence = await collectSupplierEvidence(parsed.suppliers, criteria, fetchImpl, controller.signal, maxLinks);
    parsed = { ...parsed, suppliers: parsed.suppliers.filter((supplier) => evidence.reachableUrls.has(canonicalUrl(supplier.source.url))) };
    if (parsed.suppliers.length && evidence.documents.length) {
      try {
        const enrichmentRequest = createYandexEnrichmentRequest(criteria, folderId, model, parsed.suppliers, evidence.documents);
        const enrichmentPayload = await callYandex(enrichmentRequest, "enrich");
        const enriched = parseYandexResponse(enrichmentPayload, new Date(now), [...search.citations, ...evidence.citations]);
        const allowedHosts = new Set(parsed.suppliers.flatMap((supplier) => supplier.sources.map((source) => new URL(source.url).hostname.replace(/^www\./, "").toLocaleLowerCase("en-US"))));
        const enrichedSuppliers = enriched.suppliers.filter((supplier) => {
          const hostname = new URL(supplier.source.url).hostname.replace(/^www\./, "").toLocaleLowerCase("en-US");
          return allowedHosts.has(hostname) && servesRequestedRegion(supplier, criteria.region) && evidence.reachableUrls.has(canonicalUrl(supplier.source.url));
        });
        const enrichedByHost = new Map(enrichedSuppliers.map((supplier) => [new URL(supplier.source.url).hostname.replace(/^www\./, "").toLocaleLowerCase("en-US"), supplier]));
        const suppliers = parsed.suppliers.map((supplier) => enrichedByHost.get(new URL(supplier.source.url).hostname.replace(/^www\./, "").toLocaleLowerCase("en-US")) || supplier);
        parsed = { ...enriched, suppliers };
        logTelemetry(env, { evt: "enrichment_ok", clientId, documents: evidence.documents.length, count: enrichedSuppliers.length });
      } catch (error) {
        logTelemetry(env, { evt: "enrichment_fallback", clientId, reason: error instanceof Error ? error.message : "unknown" });
      }
    }
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError(502, "Получен неполный ответ внешнего поиска. Повторите запрос.");
  } finally {
    clearTimeout(timeout);
  }
  const value: DiscoveryResponse = {
    // Yandex can return useful but broader candidates even when a condition is
    // marked as required. Enforce every user-facing filter after enrichment,
    // when price, delivery and document fields contain the best available data.
    suppliers: parsed.suppliers.filter((supplier) => supplierMatches(supplier, criteria)),
    provider: "yandex",
    model,
    searchedAt: new Date(now).toISOString(),
    cached: false,
  };
  const cacheTtlSeconds = value.suppliers.length >= 3
    ? numberEnv(env.DISCOVERY_CACHE_TTL_SECONDS, 43_200)
    : numberEnv(env.DISCOVERY_LOW_RESULT_CACHE_TTL_SECONDS, 900);
  if (value.suppliers.length > 0) {
    cache.set(cacheKey, { expiresAt: now + cacheTtlSeconds * 1000, value });
  }
  logTelemetry(env, { evt: "ok", clientId, region: criteria.region, category: criteria.category, query: criteria.query.slice(0, 80), cached: false, count: value.suppliers.length, ms: Date.now() - startedReal });
  return value;
}

export function resetDiscoveryStateForTests() {
  cache.clear(); clientRequests.clear(); dailyWindow = ""; dailyRequests = 0; lastClientCleanup = 0;
}
