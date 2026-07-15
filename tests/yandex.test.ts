import assert from "node:assert/strict";
import test from "node:test";
import { discoverSuppliers, DiscoveryError, resetDiscoveryStateForTests, verifyAccessCode } from "../app/lib/discovery";
import { createYandexEnrichmentRequest, createYandexSearchRequest, createYandexStructureRequest, parseYandexResponse, parseYandexSearchResponse } from "../app/lib/yandex";
import type { SearchCriteria } from "../app/types";

const criteria: SearchCriteria = { query: "морс", category: "Напитки", region: "Свердловская область", city: "Екатеринбург", quantity: 100, quantityUnit: "л", requiresCertificates: true, requiresDelivery: true, requiresPublishedPrice: false };

const result = { suppliers: [{ name: "Уральские напитки Тест", region: "Свердловская область", city: "Екатеринбург", description: "Производитель безалкогольных напитков и ягодных морсов для оптовых покупателей.", categories: ["Напитки"], products: ["морс", "лимонад"], serviceAreas: ["Екатеринбург", "Свердловская область"], minimumOrder: "100 л", price: "Не указано", certificates: "Декларации соответствия указаны на сайте", delivery: "Доставка по Екатеринбургу", website: "https://example-supplier.ru/", phone: "+7 (343) 200-10-20", email: "Sales@Example-Supplier.ru", sourceUrls: ["https://example-supplier.ru/catalog"], evidence: [{ field: "minimumOrder", sourceUrl: "https://example-supplier.ru/catalog" }, { field: "certificates", sourceUrl: "https://example-supplier.ru/catalog" }, { field: "delivery", sourceUrl: "https://example-supplier.ru/catalog" }, { field: "contacts", sourceUrl: "https://example-supplier.ru/catalog" }] }] };

const searchPayload = { output: [
  { type: "web_search_call", action: { sources: [{ url: "https://example-supplier.ru/catalog", title: "Каталог производителя" }] } },
  { type: "message", content: [{ type: "output_text", text: "Найден поставщик Уральские напитки Тест. Источник: каталог производителя.", annotations: [{ type: "url_citation", url: "https://example-supplier.ru/catalog", title: "Каталог производителя" }] }] },
] };
const structurePayload = { output: [
  { type: "message", content: [{ type: "output_text", text: JSON.stringify(result), annotations: [] }] },
] };

test("separates required web search from strict structured output", () => {
  const search = createYandexSearchRequest(criteria, "folder-id", "yandexgpt-lite");
  assert.equal(search.model, "gpt://folder-id/yandexgpt-lite");
  assert.equal(search.tool_choice, "required");
  assert.equal(search.tools[0].type, "web_search");
  assert.equal(search.tools[0].search_context_size, "high");
  assert.equal(search.max_tool_calls, 5);
  assert.match(search.instructions, /прайс-листа/);
  assert.equal("text" in search, false);

  const automaticCategory = createYandexSearchRequest({ ...criteria, category: "Все категории" }, "folder-id", "yandexgpt-lite");
  assert.match(automaticCategory.input, /Категория: определи автоматически по товару/i);
  assert.match(automaticCategory.instructions, /категорию автоматически/i);

  const structure = createYandexStructureRequest(criteria, "folder-id", "yandexgpt-lite", "Результаты поиска", [{ url: "https://example-supplier.ru/catalog", title: "Каталог" }]);
  assert.equal(structure.text.format.type, "json_schema");
  assert.equal(structure.text.format.strict, true);
  assert.equal("tools" in structure, false);

  const preliminary = parseYandexResponse(structurePayload, new Date("2026-07-15T12:00:00Z"), parseYandexSearchResponse(searchPayload).citations).suppliers;
  const enrichment = createYandexEnrichmentRequest(criteria, "folder-id", "yandexgpt-lite", preliminary, [{ supplierName: preliminary[0].name, url: "https://example-supplier.ru/catalog", title: "Каталог", mediaType: "html", text: "Цена 120 ₽/л" }]);
  assert.equal(enrichment.text.format.type, "json_schema");
  assert.match(enrichment.instructions, /не подменяй минимальный заказ/i);
  assert.match(enrichment.instructions, /«от N ₽\/кг»/);
  assert.match(enrichment.instructions, /RUB\/RUR/);
  assert.match(enrichment.input, /Цена 120 ₽\/л/);
});

test("maps only cited HTTP sources to live supplier cards", () => {
  const search = parseYandexSearchResponse(searchPayload);
  const parsed = parseYandexResponse(structurePayload, new Date("2026-07-15T12:00:00Z"), search.citations);
  assert.equal(parsed.suppliers.length, 1);
  assert.equal(parsed.suppliers[0].origin, "live");
  assert.equal(parsed.suppliers[0].source.url, "https://example-supplier.ru/catalog");
  assert.equal(parsed.suppliers[0].minimumOrder.value, 100);
  assert.equal(parsed.suppliers[0].contacts.phone, "+7 (343) 200-10-20");
  assert.equal(parsed.suppliers[0].contacts.email, "sales@example-supplier.ru");

  const unsafe = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suppliers: [{ ...result.suppliers[0], website: "javascript:alert(1)", sourceUrls: ["https://uncited.invalid/"] }] }), annotations: [] }] }] };
  assert.equal(parseYandexResponse(unsafe).suppliers.length, 0);

  const marketplace = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suppliers: [{ ...result.suppliers[0], name: "Авито" }] }), annotations: [] }] }] };
  assert.equal(parseYandexResponse(marketplace, new Date(), search.citations).suppliers.length, 0);

  const badContacts = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suppliers: [{ ...result.suppliers[0], phone: "Не указано", email: "нет" }] }), annotations: [] }] }] };
  const withoutContacts = parseYandexResponse(badContacts, new Date(), search.citations).suppliers[0];
  assert.equal(withoutContacts.contacts.phone, undefined);
  assert.equal(withoutContacts.contacts.email, undefined);

  const inferredEvidence = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suppliers: [{ ...result.suppliers[0], minimumOrder: "Не указано", price: "120 ₽/л", evidence: [{ field: "minimumOrder", sourceUrl: "https://example-supplier.ru/catalog" }] }] }), annotations: [] }] }] };
  const inferred = parseYandexResponse(inferredEvidence, new Date(), search.citations).suppliers[0];
  assert.equal(inferred.factSources.minimumOrder, undefined);
  assert.equal(inferred.factSources.price?.url, "https://example-supplier.ru/catalog");

  const aggregatorPayload = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suppliers: [{ ...result.suppliers[0], name: "Мясной хуторок", website: "https://agroserver.ru/govyadina", sourceUrls: ["https://agroserver.ru/govyadina"], evidence: [] }] }), annotations: [] }] }] };
  assert.equal(parseYandexResponse(aggregatorPayload, new Date(), [{ url: "https://agroserver.ru/govyadina", title: "Объявление" }]).suppliers.length, 0);

  const numericPricePayload = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suppliers: [{ ...result.suppliers[0], price: "137.50", evidence: [{ field: "price", sourceUrl: "https://example-supplier.ru/catalog" }] }] }), annotations: [] }] }] };
  const numericPrice = parseYandexResponse(numericPricePayload, new Date(), [{ url: "https://example-supplier.ru/catalog", title: "Товар", excerpt: '{"price":"137.50","priceCurrency":"RUB","unitText":"шт"}' }]).suppliers[0];
  assert.equal(numericPrice.price.available, true);
  assert.equal(numericPrice.price.text, "137.50 ₽/шт.");

  const parsedPrice = (price: string, excerpt: string) => {
    const payload = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suppliers: [{ ...result.suppliers[0], price, evidence: [{ field: "price", sourceUrl: "https://example-supplier.ru/catalog" }] }] }), annotations: [] }] }] };
    return parseYandexResponse(payload, new Date(), [{ url: "https://example-supplier.ru/catalog", title: "Прайс", excerpt }]).suppliers[0].price;
  };
  assert.deepEqual(parsedPrice("2 750", "Прайс: Цена, руб./короб | Смесь ягодная | 2 750"), { available: true, text: "2 750 ₽/короб" });
  assert.deepEqual(parsedPrice("от 180 до 220", "Смесь ягодная — цена от 180 до 220 руб. за кг"), { available: true, text: "от 180 до 220 ₽/кг" });
  assert.equal(parsedPrice("1 290 р./кг", "Цена 1 290 р./кг").available, true);
  assert.equal(parsedPrice("3,45 EUR/упак.", "Цена 3,45 EUR/упак.").available, true);
  assert.equal(parsedPrice("5 USD за 100 г", "Цена 5 USD за 100 г").available, true);

  const catalogPrices = parsedPrice("129 руб., 194 руб., 788 руб., 1 640 руб., 188 руб., 312 руб.", "Каталог чая содержит несколько товарных позиций и цен");
  assert.deepEqual(catalogPrices, { available: false, text: "В источнике несколько цен — точную цену товара нужно проверить" });

  const minimumOrderPayload = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suppliers: [{ ...result.suppliers[0], minimumOrder: "10000", evidence: [{ field: "minimumOrder", sourceUrl: "https://example-supplier.ru/catalog" }] }] }), annotations: [] }] }] };
  const monetaryMinimum = parseYandexResponse(minimumOrderPayload, new Date(), [{ url: "https://example-supplier.ru/catalog", title: "Карточка товара", excerpt: "Минимальная сумма заказа — 10 000 руб. Доставка рассчитывается отдельно." }]).suppliers[0].minimumOrder;
  assert.deepEqual(monetaryMinimum, { value: 10000, unit: "₽", text: "10000 ₽" });

  const unknownNamePayload = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suppliers: [{ ...result.suppliers[0], name: "Не указано" }] }), annotations: [] }] }] };
  const restoredName = parseYandexResponse(unknownNamePayload, new Date(), [{ url: "https://example-supplier.ru/catalog", title: "Чай.ru - интернет-магазин чая" }]).suppliers[0];
  assert.equal(restoredName.name, "Чай.ru");

  const duplicateHostPayload = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suppliers: [result.suppliers[0], { ...result.suppliers[0], name: "Уральские напитки — филиал" }] }), annotations: [] }] }] };
  assert.equal(parseYandexResponse(duplicateHostPayload, new Date(), search.citations).suppliers.length, 1);

  const regtorgPayload = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suppliers: [{ ...result.suppliers[0], name: "1095 предложений молока", website: "https://vladimir.regtorg.ru/goods/moloko.html", sourceUrls: ["https://vladimir.regtorg.ru/goods/moloko.html"], evidence: [] }] }), annotations: [] }] }] };
  assert.equal(parseYandexResponse(regtorgPayload, new Date(), [{ url: "https://vladimir.regtorg.ru/goods/moloko.html", title: "Каталог" }]).suppliers.length, 0);
});

test("caches equivalent searches before another provider call", async () => {
  resetDiscoveryStateForTests();
  let providerCalls = 0;
  let sourceChecks = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).startsWith("https://ai.api.cloud.yandex.net/")) {
      providerCalls += 1;
      return Response.json(providerCalls % 2 ? searchPayload : structurePayload);
    }
    sourceChecks += 1;
    return new Response("", { status: 200 });
  };
  const env = { NODE_ENV: "test", YANDEX_API_KEY: "test-key", YANDEX_FOLDER_ID: "folder-id", YANDEX_MODEL: "yandexgpt-lite", DISCOVERY_CACHE_TTL_SECONDS: "3600" } as unknown as NodeJS.ProcessEnv;
  const first = await discoverSuppliers({ criteria, clientId: "client", env, fetchImpl, now: 1_752_580_800_000 });
  const second = await discoverSuppliers({ criteria, clientId: "client", env, fetchImpl, now: 1_752_580_801_000 });
  assert.equal(providerCalls, 2);
  assert.equal(sourceChecks, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);

  // Регистр, лишние пробелы и «ё» не должны порождать повторный запрос к провайдеру.
  const variant: SearchCriteria = { ...criteria, query: "  МОРС  " };
  const third = await discoverSuppliers({ criteria: variant, clientId: "client", env, fetchImpl, now: 1_752_580_802_000 });
  assert.equal(providerCalls, 2);
  assert.equal(third.cached, true);

  const afterLowResultTtl = await discoverSuppliers({ criteria, clientId: "client", env, fetchImpl, now: 1_752_581_701_000 });
  assert.equal(providerCalls, 4);
  assert.equal(afterLowResultTtl.cached, false);
});

test("enriches a preliminary card from a linked commercial-terms page", async () => {
  resetDiscoveryStateForTests();
  let providerCalls = 0;
  let sourceCalls = 0;
  const enrichedResult = {
    suppliers: [{
      ...result.suppliers[0],
      price: "120 ₽/л",
      minimumOrder: "от 100 л",
      delivery: "Доставка по Екатеринбургу от 100 л",
      sourceUrls: ["https://example-supplier.ru/price", "https://example-supplier.ru/catalog"],
      evidence: [
        { field: "price", sourceUrl: "https://example-supplier.ru/price" },
        { field: "minimumOrder", sourceUrl: "https://example-supplier.ru/price" },
        { field: "delivery", sourceUrl: "https://example-supplier.ru/price" },
      ],
    }],
  };
  const enrichedPayload = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(enrichedResult), annotations: [] }] }] };
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://ai.api.cloud.yandex.net/")) {
      providerCalls += 1;
      return Response.json(providerCalls === 1 ? searchPayload : providerCalls === 2 ? structurePayload : enrichedPayload);
    }
    sourceCalls += 1;
    if (url.endsWith("/catalog")) return new Response('<html><body><h1>Каталог напитков</h1><a href="/price">Прайс и доставка</a></body></html>', { headers: { "Content-Type": "text/html" } });
    if (url.endsWith("/price")) return new Response("<html><body>Морс: 120 ₽/л. Минимальный заказ 100 л. Доставка по Екатеринбургу.</body></html>", { headers: { "Content-Type": "text/html" } });
    return new Response("", { status: 404 });
  };
  const env = { NODE_ENV: "test", YANDEX_API_KEY: "test-key", YANDEX_FOLDER_ID: "folder-id" } as unknown as NodeJS.ProcessEnv;
  const response = await discoverSuppliers({ criteria, clientId: "enrichment-client", env, fetchImpl });
  assert.equal(providerCalls, 3);
  assert.equal(sourceCalls, 2);
  assert.equal(response.suppliers[0].price.available, true);
  assert.equal(response.suppliers[0].factSources.price?.url, "https://example-supplier.ru/price");
  assert.equal(response.suppliers[0].sources.length, 2);
});

test("retries only the structuring stage after an incomplete model response", async () => {
  resetDiscoveryStateForTests();
  let providerCalls = 0;
  const incomplete = { output: [{ type: "message", content: [{ type: "output_text", text: "{not-json", annotations: [] }] }] };
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).startsWith("https://ai.api.cloud.yandex.net/")) {
      providerCalls += 1;
      return Response.json(providerCalls === 1 ? searchPayload : providerCalls === 2 ? incomplete : structurePayload);
    }
    return new Response("", { status: 200 });
  };
  const env = { NODE_ENV: "test", YANDEX_API_KEY: "test-key", YANDEX_FOLDER_ID: "folder-id" } as unknown as NodeJS.ProcessEnv;
  const response = await discoverSuppliers({ criteria, clientId: "retry-client", env, fetchImpl });
  assert.equal(providerCalls, 3);
  assert.equal(response.suppliers.length, 1);
});

test("enforces the access code only when it is configured", async () => {
  resetDiscoveryStateForTests();
  let providerCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).startsWith("https://ai.api.cloud.yandex.net/")) { providerCalls += 1; return Response.json(providerCalls % 2 ? searchPayload : structurePayload); }
    return new Response("", { status: 200 });
  };
  const env = { NODE_ENV: "test", YANDEX_API_KEY: "test-key", YANDEX_FOLDER_ID: "folder-id", ACCESS_CODE: "secret" } as unknown as NodeJS.ProcessEnv;
  await assert.rejects(
    discoverSuppliers({ criteria, clientId: "c1", accessCode: "wrong", env, fetchImpl }),
    (error: unknown) => error instanceof DiscoveryError && error.status === 401,
  );
  assert.equal(providerCalls, 0);
  const ok = await discoverSuppliers({ criteria, clientId: "c2", accessCode: " secret ", env, fetchImpl });
  assert.equal(ok.provider, "yandex");
});

test("verifies the shared access code without starting a search", () => {
  const protectedEnv = { ACCESS_CODE: "shared-secret" } as unknown as NodeJS.ProcessEnv;
  assert.doesNotThrow(() => verifyAccessCode(" shared-secret ", protectedEnv));
  assert.throws(
    () => verifyAccessCode("wrong", protectedEnv),
    (error: unknown) => error instanceof DiscoveryError && error.status === 401,
  );
  assert.doesNotThrow(() => verifyAccessCode("", {} as NodeJS.ProcessEnv));
});

test("drops a live card when its cited page is no longer reachable", async () => {
  resetDiscoveryStateForTests();
  let providerCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).startsWith("https://ai.api.cloud.yandex.net/")) {
      providerCalls += 1;
      return Response.json(providerCalls === 1 ? searchPayload : structurePayload);
    }
    return new Response("", { status: 404 });
  };
  const env = { NODE_ENV: "test", YANDEX_API_KEY: "test-key", YANDEX_FOLDER_ID: "folder-id" } as unknown as NodeJS.ProcessEnv;
  const response = await discoverSuppliers({ criteria, clientId: "client", env, fetchImpl });
  assert.equal(response.suppliers.length, 0);
});

test("drops a live card that is not tied to the requested subject", async () => {
  resetDiscoveryStateForTests();
  let providerCalls = 0;
  const wrongRegionPayload = { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ suppliers: [{ ...result.suppliers[0], region: "Московская область", serviceAreas: ["Московская область"] }] }), annotations: [] }] }] };
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).startsWith("https://ai.api.cloud.yandex.net/")) {
      providerCalls += 1;
      return Response.json(providerCalls === 1 ? searchPayload : wrongRegionPayload);
    }
    return new Response("", { status: 200 });
  };
  const env = { NODE_ENV: "test", YANDEX_API_KEY: "test-key", YANDEX_FOLDER_ID: "folder-id" } as unknown as NodeJS.ProcessEnv;
  const response = await discoverSuppliers({ criteria, clientId: "client", env, fetchImpl });
  assert.equal(response.suppliers.length, 0);
});

test("explains missing Yandex Responses API permissions", async () => {
  resetDiscoveryStateForTests();
  const fetchImpl: typeof fetch = async () => Response.json({ error: "Forbidden" }, { status: 403 });
  const env = { NODE_ENV: "test", YANDEX_API_KEY: "test-key", YANDEX_FOLDER_ID: "folder-id" } as unknown as NodeJS.ProcessEnv;
  await assert.rejects(
    discoverSuppliers({ criteria, clientId: "client", env, fetchImpl }),
    (error: unknown) => error instanceof Error && /API-ключ.*роли/.test(error.message),
  );
});

test("built function exposes a callable Yandex entrypoint", async () => {
  const bundle = await import(new URL("../dist-function/index.js", import.meta.url).href) as { handler: (event: unknown) => Promise<{ statusCode: number; body: string }> };
  assert.equal(typeof bundle.handler, "function");
  const response = await bundle.handler({ httpMethod: "GET", headers: { origin: "https://donmiguel66.github.io" } });
  assert.equal(response.statusCode, 200);
  const forbidden = await bundle.handler({ httpMethod: "POST", headers: { origin: "https://example.invalid" }, body: "{}" });
  assert.equal(forbidden.statusCode, 403);
  const access = await bundle.handler({ httpMethod: "POST", headers: { origin: "https://donmiguel66.github.io" }, body: JSON.stringify({ action: "verify-access", accessCode: "" }) });
  assert.equal(access.statusCode, 200);
  assert.deepEqual(JSON.parse(access.body), { authorized: true });
  const unconfigured = await bundle.handler({ httpMethod: "POST", headers: { origin: "https://donmiguel66.github.io" }, body: JSON.stringify({ criteria }) });
  assert.equal(unconfigured.statusCode, 503);
});
