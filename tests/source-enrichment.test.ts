import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { collectSupplierEvidence, isPublicHttpUrl } from "../app/lib/source-enrichment";
import type { SearchCriteria, Supplier } from "../app/types";

const criteria: SearchCriteria = {
  query: "говядина",
  category: "Мясо",
  region: "Свердловская область",
  city: "Екатеринбург",
  quantityUnit: "кг",
  requiresCertificates: false,
  requiresDelivery: true,
  requiresPublishedPrice: true,
};

function supplier(url: string): Supplier {
  const source = { url, title: "Карточка товара", publisher: new URL(url).hostname, checkedAt: "15.07.2026", confidence: "medium" as const };
  return {
    id: "supplier-1",
    name: "Тестовый поставщик",
    region: "Свердловская область",
    city: "Екатеринбург",
    description: "Поставщик мяса и продуктов питания оптом.",
    categories: ["Мясо"],
    products: ["говядина"],
    serviceAreas: ["Свердловская область"],
    minimumOrder: { text: "Не указано" },
    price: { available: false, text: "Не указано" },
    certificates: { status: "unknown", text: "Не указано" },
    delivery: { available: null, text: "Не указано" },
    contacts: { website: url },
    source,
    sources: [source],
    factSources: {},
    verifiedAt: "15.07.2026",
    origin: "live",
  };
}

function xlsxPrice(): Uint8Array {
  const sharedStrings = `<?xml version="1.0"?><sst><si><t>Товар</t></si><si><t>Цена, руб/кг</t></si><si><t>Говядина лопатка</t></si></sst>`;
  const sheet = `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row r="2"><c t="s"><v>2</v></c><c><v>450</v></c></row></sheetData></worksheet>`;
  return zipSync({ "xl/sharedStrings.xml": strToU8(sharedStrings), "xl/worksheets/sheet1.xml": strToU8(sheet) });
}

test("follows one relevant HTML link and extracts a matching XLSX price row", async () => {
  const rootUrl = "https://supplier.example/govyadina";
  const xlsx = xlsxPrice();
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/govyadina")) return new Response('<html><head><title>Говядина оптом</title></head><body><p>Говядина оптом.</p><a href="/assortiment">Говядина и другие товары</a><a href="/price">Прайс и доставка</a><a href="/files/price.xlsx">Скачать прайс XLSX</a></body></html>', { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (url.endsWith("/price")) return new Response("<html><body><h1>Прайс</h1><p>Доставка по городу от 5 кг. Бесплатно от 50 000 руб.</p></body></html>", { headers: { "Content-Type": "text/html" } });
    if (url.endsWith("price.xlsx")) return new Response(xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.byteLength) as ArrayBuffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
    return new Response("", { status: 404 });
  };
  const evidence = await collectSupplierEvidence([supplier(rootUrl)], criteria, fetchImpl, new AbortController().signal, 2);
  assert.equal(evidence.documents.length, 3);
  assert.ok(evidence.documents.some((document) => document.url.endsWith("/price") && /от 5 кг/.test(document.text)));
  assert.equal(evidence.documents.some((document) => document.url.endsWith("/assortiment")), false);
  assert.ok(evidence.documents.some((document) => document.mediaType === "xlsx" && /Говядина лопатка \| 450/.test(document.text)));
  assert.ok(evidence.reachableUrls.has(rootUrl));
});

test("extracts product price and delivery threshold from a linked JSON-LD page", async () => {
  const rootUrl = "https://dairy.example/catalog/moloko-3-2";
  const milkCriteria: SearchCriteria = { ...criteria, query: "молоко 3,2 процента", category: "Молочная продукция" };
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/catalog/moloko-3-2")) return new Response('<html><body><a href="/catalog/product/moloko-3-2-973">Молоко ультрапастеризованное 3,2%</a></body></html>', { headers: { "Content-Type": "text/html" } });
    if (url.endsWith("/catalog/product/moloko-3-2-973")) return new Response('<html><head><title>Молоко 3,2%</title><meta itemprop="price" content="137.50"><meta itemprop="priceCurrency" content="RUB"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Молоко 3,2%","offers":{"@type":"Offer","price":"137.50","priceCurrency":"RUB","unitText":"шт","availability":"https://schema.org/InStock"}}</script></head><body><p>Доставка доступна при заказе от 12 500 ₽.</p></body></html>', { headers: { "Content-Type": "text/html" } });
    return new Response("", { status: 404 });
  };
  const evidence = await collectSupplierEvidence([supplier(rootUrl)], milkCriteria, fetchImpl, new AbortController().signal, 2);
  const product = evidence.documents.find((document) => document.url.includes("/catalog/product/"));
  assert.ok(product);
  assert.match(product.text, /"price":"137.50"/);
  assert.match(product.text, /itemprop="price" content="137.50"/);
  assert.match(product.text, /12 500 ₽/);
});

test("rejects local and private enrichment URLs", () => {
  assert.equal(isPublicHttpUrl("https://supplier.example/catalog"), true);
  assert.equal(isPublicHttpUrl("http://127.0.0.1/private"), false);
  assert.equal(isPublicHttpUrl("http://192.168.1.5/private"), false);
  assert.equal(isPublicHttpUrl("http://localhost/private"), false);
});
