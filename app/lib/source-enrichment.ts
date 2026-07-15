import { strFromU8, unzipSync } from "fflate";
import { lookup } from "node:dns/promises";
import type { SearchCriteria, Supplier } from "../types";
import type { Citation } from "./yandex";

const HTML_LIMIT = 1_500_000;
const XLSX_LIMIT = 8_000_000;
const MAX_DOCUMENT_TEXT = 18_000;
const REDIRECT_LIMIT = 3;

export interface EnrichmentDocument {
  supplierId: string;
  supplierName: string;
  url: string;
  title: string;
  mediaType: "html" | "xlsx" | "pdf";
  text: string;
}

export interface EnrichmentResult {
  documents: EnrichmentDocument[];
  citations: Citation[];
  reachableUrls: Set<string>;
}

interface LoadedDocument {
  reachable: boolean;
  document?: Omit<EnrichmentDocument, "supplierId" | "supplierName">;
  links: string[];
}

function normalizedHost(value: string): string {
  try { return new URL(value).hostname.replace(/^www\./, "").toLocaleLowerCase("en-US"); }
  catch { return ""; }
}

export function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    url.hostname = url.hostname.toLocaleLowerCase("en-US");
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return value;
  }
}

export function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    const hostname = url.hostname.toLocaleLowerCase("en-US");
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
    if (hostname === "::1" || hostname.includes(":")) return false;
    const octets = hostname.split(".").map(Number);
    if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      const [a, b] = octets;
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sameSite(left: string, right: string): boolean {
  return normalizedHost(left) !== "" && normalizedHost(left) === normalizedHost(right);
}

function isPrivateIpAddress(value: string): boolean {
  const normalized = value.toLocaleLowerCase("en-US").replace(/^::ffff:/, "");
  const octets = normalized.split(".").map(Number);
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized);
}

async function resolvesOnlyToPublicAddresses(value: string): Promise<boolean> {
  try {
    const addresses = await lookup(new URL(value).hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((entry) => !isPrivateIpAddress(entry.address));
  } catch {
    return false;
  }
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return named[code.toLocaleLowerCase("en-US")] ?? entity;
  });
}

function plainText(value: string): string {
  return decodeEntities(value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function queryTokens(criteria: SearchCriteria): string[] {
  return `${criteria.query} ${criteria.category}`
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9%]+/i)
    .filter((token) => token.length >= 4 && !["категории", "продукция", "продукты", "товары"].includes(token))
    .slice(0, 8);
}

function focusedVisibleText(html: string, criteria: SearchCriteria): string {
  const withoutNoise = html
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const lines = decodeEntities(withoutNoise).split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line.length > 2);
  const tokens = queryTokens(criteria);
  const factPattern = /цена|прайс|руб|₽|миним|заказ|достав|самовывоз|сертифик|декларац|телефон|e-?mail|налич/i;
  const selected = lines.filter((line, index) => index < 35 || factPattern.test(line) || tokens.some((token) => line.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").includes(token)));
  return [...new Set(selected)].join("\n").slice(0, MAX_DOCUMENT_TEXT);
}

function jsonLdText(html: string): string {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const values: string[] = [];
  for (const block of blocks.slice(0, 10)) {
    const raw = decodeEntities(block[1]).trim();
    try {
      const data = JSON.parse(raw) as unknown;
      const queue: unknown[] = [data];
      while (queue.length) {
        const current = queue.shift();
        if (Array.isArray(current)) { queue.push(...current); continue; }
        if (!current || typeof current !== "object") continue;
        const object = current as Record<string, unknown>;
        const type = Array.isArray(object["@type"]) ? object["@type"].join(",") : String(object["@type"] ?? "");
        if (/Product|Offer|Organization|LocalBusiness/i.test(type)) values.push(JSON.stringify(object));
        if (object.offers) queue.push(object.offers);
        if (object["@graph"]) queue.push(object["@graph"]);
      }
    } catch {
      // Некорректный JSON-LD не должен ломать обогащение всей карточки.
    }
  }
  return values.join("\n").slice(0, 12_000);
}

function embeddedCommerceText(html: string): string {
  const keys = "price|basePrice|salePrice|oldPrice|currentPrice|finalPrice|lowPrice|highPrice|priceCurrency|minPriceCourier|minPricePickup|minCountToBuy|measureSymbol|unitText|unitCode|quantityIn|inStock|telephone|email";
  const scriptValues = [...html.matchAll(new RegExp(`.{0,90}["'](?:${keys})["']\\s*:\\s*(?:["'][^"']{0,180}["']|-?\\d+(?:\\.\\d+)?|true|false).{0,100}`, "gi"))]
    .slice(0, 40)
    .map((match) => decodeEntities(match[0]).replace(/\\u003c|\\u003e/g, " ").replace(/\\[rnt]/g, " ").replace(/\s+/g, " ").trim());
  const metadata = [...html.matchAll(/<[^>]{0,700}(?:(?:itemprop|property|name)\s*=\s*["'](?:price|priceCurrency|product:price:(?:amount|currency))["']|data-(?:product-)?price\s*=|data-currency\s*=)[^>]{0,700}>/gi)]
    .slice(0, 40)
    .map((match) => decodeEntities(match[0]).replace(/\s+/g, " ").trim());
  return [...new Set([...scriptValues, ...metadata])].join("\n").slice(0, 8_000);
}

function linkScore(url: string, anchor: string, criteria: SearchCriteria): number {
  const value = `${url} ${anchor}`.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  let score = 0;
  if (/прайс|price|цена/.test(value)) score += 80;
  else if (/catalog|каталог|product|товар/.test(value)) score += 35;
  if (/достав|delivery|контакт|contact|сертифик|документ/.test(value)) score += 25;
  if (/\.xlsx?(?:$|\?)/.test(value)) score += 45;
  else if (/\.pdf(?:$|\?)/.test(value)) score += 25;
  for (const token of queryTokens(criteria)) if (value.includes(token)) score += 18;
  if (/login|signin|auth|cart|basket|favorite|compare|policy|agreement/.test(value)) score -= 80;
  return score;
}

function relevantLinks(html: string, pageUrl: string, criteria: SearchCriteria, maxLinks: number): string[] {
  const candidates = new Map<string, { url: string; score: number; file: boolean }>();
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decodeEntities(match[1]), pageUrl);
      url.hash = "";
      if (!isPublicHttpUrl(url.toString()) || !sameSite(pageUrl, url.toString()) || canonicalUrl(url.toString()) === canonicalUrl(pageUrl)) continue;
      if (/\.(?:css|js|png|jpe?g|gif|webp|svg|ico|zip|rar)(?:$|\?)/i.test(url.toString())) continue;
      const anchor = plainText(match[2]);
      const score = linkScore(url.toString(), anchor, criteria);
      if (score < 20) continue;
      const key = canonicalUrl(url.toString());
      const file = /\.(?:xlsx?|pdf)(?:$|\?)/i.test(url.toString());
      const existing = candidates.get(key);
      if (!existing || score > existing.score) candidates.set(key, { url: url.toString(), score, file });
    } catch {
      // Пропускаем относительные и повреждённые ссылки, которые не удалось нормализовать.
    }
  }
  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);
  const selected: typeof sorted = [];
  const bestHtml = sorted.find((item) => !item.file);
  const bestFile = sorted.find((item) => item.file);
  if (bestHtml) selected.push(bestHtml);
  if (bestFile && selected.length < maxLinks) selected.push(bestFile);
  for (const item of sorted) if (selected.length < maxLinks && !selected.includes(item)) selected.push(item);
  return selected.map((item) => item.url);
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); return null; }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function fetchFollowingSafeRedirects(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<{ response: Response; url: string } | null> {
  const original = url;
  let current = url;
  for (let redirects = 0; redirects <= REDIRECT_LIMIT; redirects += 1) {
    if (!isPublicHttpUrl(current) || !sameSite(original, current)) return null;
    if (fetchImpl === fetch && !await resolvesOnlyToPublicAddresses(current)) return null;
    const response = await fetchImpl(current, {
      method: "GET",
      headers: { Accept: "text/html,application/xhtml+xml,application/ld+json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf;q=0.8,*/*;q=0.4", "User-Agent": "FoodSupSearcher/0.2 supplier-enrichment" },
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    });
    if (response.status < 300 || response.status >= 400) return { response, url: current };
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) return null;
    current = new URL(location, current).toString();
  }
  return null;
}

function worksheetText(bytes: Uint8Array, criteria: SearchCriteria): string {
  try {
    let expandedSize = 0;
    const archive = unzipSync(bytes, { filter: (file) => {
      const relevant = file.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/i.test(file.name);
      if (!relevant || file.originalSize > 4_000_000 || expandedSize + file.originalSize > 12_000_000) return false;
      expandedSize += file.originalSize;
      return true;
    } });
    const sharedXml = archive["xl/sharedStrings.xml"] ? strFromU8(archive["xl/sharedStrings.xml"]) : "";
    const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((item) => plainText(item[1]));
    const tokens = queryTokens(criteria);
    const output: string[] = [];
    for (const [name, content] of Object.entries(archive).filter(([entry]) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry)).slice(0, 8)) {
      const xml = strFromU8(content);
      const rows: string[] = [];
      for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
        const cells: string[] = [];
        for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
          const type = /\bt=["']([^"']+)["']/i.exec(cell[1])?.[1] ?? "";
          const value = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(cell[2])?.[1] ?? /<t\b[^>]*>([\s\S]*?)<\/t>/i.exec(cell[2])?.[1] ?? "";
          const decoded = type === "s" ? shared[Number(value)] ?? value : decodeEntities(value);
          if (decoded.trim()) cells.push(decoded.trim());
        }
        if (cells.length) rows.push(cells.join(" | "));
      }
      const matched = rows.filter((row) => {
        const normalized = row.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
        return tokens.some((token) => normalized.includes(token));
      });
      if (matched.length) output.push(`${name}: заголовки/первые строки:\n${rows.slice(0, 8).join("\n")}\nСтроки по запросу:\n${matched.slice(0, 30).join("\n")}`);
    }
    return output.join("\n\n").slice(0, 30_000);
  } catch {
    return "";
  }
}

async function loadDocument(url: string, criteria: SearchCriteria, fetchImpl: typeof fetch, signal: AbortSignal, maxLinks: number): Promise<LoadedDocument> {
  try {
    const loaded = await fetchFollowingSafeRedirects(url, fetchImpl, signal);
    if (!loaded) return { reachable: false, links: [] };
    const { response } = loaded;
    const reachable = (response.status >= 200 && response.status < 400) || response.status === 401 || response.status === 403 || response.status === 429;
    if (!reachable || response.status >= 400) { await response.body?.cancel(); return { reachable, links: [] }; }
    const finalUrl = loaded.url;
    const contentType = response.headers.get("content-type")?.toLocaleLowerCase("en-US") ?? "";
    const pathname = new URL(finalUrl).pathname.toLocaleLowerCase("en-US");
    if (contentType.includes("spreadsheet") || /\.xlsx?$/.test(pathname)) {
      const bytes = await readLimited(response, XLSX_LIMIT);
      const text = bytes ? worksheetText(bytes, criteria) : "";
      return { reachable, links: [], ...(text ? { document: { url: finalUrl, title: `XLSX-прайс ${new URL(finalUrl).pathname.split("/").at(-1)}`, mediaType: "xlsx", text } } : {}) };
    }
    if (contentType.includes("pdf") || /\.pdf$/.test(pathname)) {
      await response.body?.cancel();
      return { reachable, links: [], document: { url: finalUrl, title: `PDF-прайс ${new URL(finalUrl).pathname.split("/").at(-1)}`, mediaType: "pdf", text: "На официальном сайте обнаружен опубликованный PDF-прайс. Точные значения из PDF автоматически не извлекались." } };
    }
    const bytes = await readLimited(response, HTML_LIMIT);
    if (!bytes) return { reachable, links: [] };
    const html = new TextDecoder("utf-8").decode(bytes);
    const title = plainText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? normalizedHost(finalUrl));
    const text = [jsonLdText(html), embeddedCommerceText(html), focusedVisibleText(html, criteria)].filter(Boolean).join("\n\n").slice(0, MAX_DOCUMENT_TEXT);
    return {
      reachable,
      links: relevantLinks(html, finalUrl, criteria, maxLinks),
      ...(text ? { document: { url: finalUrl, title, mediaType: "html", text } } : {}),
    };
  } catch {
    return { reachable: false, links: [] };
  }
}

export async function collectSupplierEvidence(
  suppliers: Supplier[],
  criteria: SearchCriteria,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  maxLinksPerSupplier = 2,
): Promise<EnrichmentResult> {
  const reachableUrls = new Set<string>();
  const groups = await Promise.all(suppliers.slice(0, 8).map(async (supplier) => {
    const root = await loadDocument(supplier.source.url, criteria, fetchImpl, signal, maxLinksPerSupplier);
    if (root.reachable) reachableUrls.add(canonicalUrl(supplier.source.url));
    const secondary = await Promise.all(root.links.slice(0, maxLinksPerSupplier).map((url) => loadDocument(url, criteria, fetchImpl, signal, 0)));
    const loaded = [root, ...secondary];
    for (const [index, item] of loaded.entries()) if (item.reachable) {
      reachableUrls.add(canonicalUrl(index === 0 ? supplier.source.url : root.links[index - 1]));
      if (item.document) reachableUrls.add(canonicalUrl(item.document.url));
    }
    return loaded.flatMap((item): EnrichmentDocument[] => item.document ? [{ ...item.document, supplierId: supplier.id, supplierName: supplier.name }] : []);
  }));
  const documents = groups.flat();
  const citations = documents.map((document): Citation => ({ url: document.url, title: document.title, confidence: document.mediaType === "pdf" ? "medium" : "high", excerpt: document.text.slice(0, 8_000) }));
  return { documents, citations, reachableUrls };
}
