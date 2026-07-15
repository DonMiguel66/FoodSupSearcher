import assert from "node:assert/strict";
import test from "node:test";
import { calculateCompleteness, calculateMatch, compareRankedSuppliers, createOutreachMessage, supplierMatches } from "../app/lib/matching";
import { getManagerChecklist } from "../app/lib/checklist";
import type { SearchCriteria, Supplier } from "../app/types";

const makeSupplier = (overrides: Partial<Supplier> = {}): Supplier => ({
  id: "dairy-ekb",
  name: "Тестовый молочный поставщик",
  region: "Свердловская область",
  city: "Екатеринбург",
  description: "Оптовые поставки моцареллы и плавленых сыров для HoReCa",
  categories: ["Молочная продукция"],
  products: ["моцарелла", "плавленые сыры"],
  serviceAreas: ["Свердловская область", "Вся область"],
  minimumOrder: { unit: "кг", text: "Уточняется у поставщика" },
  price: { available: false, text: "Цена по запросу" },
  certificates: { status: "partial", text: "Перечень документов нужно запросить" },
  delivery: { available: true, text: "Доставка по Свердловской области" },
  contacts: { website: "https://example.com/dairy" },
  source: { url: "https://example.com/dairy", title: "Страница поставщика", publisher: "example.com", checkedAt: "15.07.2026", confidence: "medium" },
  sources: [{ url: "https://example.com/dairy", title: "Страница поставщика", publisher: "example.com", checkedAt: "15.07.2026", confidence: "medium" }],
  factSources: {},
  verifiedAt: "15.07.2026",
  origin: "live",
  ...overrides,
});

const dairy = makeSupplier();
const packaging = makeSupplier({
  id: "packaging-ekb",
  name: "Тестовая упаковка",
  description: "Контейнеры и пакеты для доставки еды",
  categories: ["Упаковка"],
  products: ["контейнеры", "пакеты"],
  price: { available: true, text: "от 10 ₽/шт" },
  contacts: { website: "https://example.com/packaging" },
  source: { url: "https://example.com/packaging", title: "Страница упаковки", publisher: "example.com", checkedAt: "15.07.2026", confidence: "medium" },
});
const partialDairy = makeSupplier({
  id: "partial-dairy",
  name: "Тестовый сырзавод",
  description: "Молочная продукция оптом",
  products: ["сыр"],
  contacts: { website: "https://example.com/cheese" },
  source: { url: "https://example.com/cheese", title: "Страница сырзавода", publisher: "example.com", checkedAt: "15.07.2026", confidence: "medium" },
});

const criteria: SearchCriteria = { query: "моцарелла", category: "Молочная продукция", region: "Свердловская область", city: "Екатеринбург", quantity: 50, quantityUnit: "кг", requiresCertificates: true, requiresDelivery: false, requiresPublishedPrice: false };

test("ranks a relevant dairy supplier above packaging", () => {
  assert.ok(calculateMatch(dairy, criteria).score > calculateMatch(packaging, criteria).score);
});

test("ranks a full multi-token product match above a partial category match", () => {
  const detailedCriteria: SearchCriteria = { ...criteria, query: "плавленые сыры", requiresCertificates: false };
  assert.ok(calculateMatch(dairy, detailedCriteria).score > calculateMatch(partialDairy, detailedCriteria).score);
});

test("ranks a data-complete supplier above a sparse one on equal query relevance", () => {
  const sparse = makeSupplier({ id: "sparse", minimumOrder: { text: "Не указано" }, price: { available: false, text: "Не указано" }, contacts: { website: "https://example.com/sparse" } });
  const complete = makeSupplier({ id: "complete", minimumOrder: { value: 3, unit: "кг", text: "от 3 кг" }, price: { available: true, text: "от 650 ₽/кг" }, contacts: { website: "https://example.com/complete", phone: "+7 343 200-10-20" } });
  const automaticCategory: SearchCriteria = { ...criteria, category: "Все категории", quantity: undefined, requiresCertificates: false };
  const ranked = [sparse, complete]
    .map((supplier) => ({ supplier, match: calculateMatch(supplier, automaticCategory) }))
    .sort(compareRankedSuppliers);

  assert.equal(ranked[0].supplier.id, "complete");
  // Подтверждённость данных теперь влияет на итоговую оценку, а не только на тай-брейк.
  assert.ok(ranked[0].match.score > ranked[1].match.score);
  assert.ok(ranked[0].match.completeness > ranked[1].match.completeness);
  assert.ok(ranked[0].match.breakdown.some((item) => item.key === "data"));
});

test("filters live results by category and published price", () => {
  const filter: SearchCriteria = { ...criteria, query: "", category: "Упаковка", requiresCertificates: false, requiresPublishedPrice: true };
  const matches = [dairy, packaging, partialDairy].filter((supplier) => supplierMatches(supplier, filter));
  assert.deepEqual(matches.map((supplier) => supplier.id), ["packaging-ekb"]);
});

test("enforces all mandatory supplier conditions", () => {
  const strict: SearchCriteria = {
    ...criteria,
    requiresCertificates: true,
    requiresDelivery: true,
    requiresPublishedPrice: true,
  };
  const complete = makeSupplier({
    price: { available: true, text: "137 ₽ / шт." },
    certificates: { status: "confirmed", text: "Декларация указана" },
    delivery: { available: true, text: "Доставка по области" },
  });
  const withoutPrice = makeSupplier({ price: { available: false, text: "Не указано" } });
  const withoutDelivery = makeSupplier({
    price: { available: true, text: "137 ₽ / шт." },
    delivery: { available: null, text: "Не указано" },
  });

  assert.equal(supplierMatches(complete, strict), true);
  assert.equal(supplierMatches(withoutPrice, strict), false);
  assert.equal(supplierMatches(withoutDelivery, strict), false);
});

test("treats a whole-region service area as covering every selected city", () => {
  const cityCriteria: SearchCriteria = { ...criteria, query: "сыр", city: "Нижний Тагил", requiresCertificates: false };
  assert.equal(supplierMatches(dairy, cityCriteria), true);
  assert.ok(calculateMatch(dairy, cityCriteria).reasons.some((reason) => reason.includes("Нижний Тагил")));
});

test("explains why incompatible quantity units cannot be compared", () => {
  const byWeight = makeSupplier({ minimumOrder: { value: 3, unit: "кг", text: "от 3 кг" } });
  const byPieces: SearchCriteria = { ...criteria, quantity: 50, quantityUnit: "шт", requiresCertificates: false };
  const match = calculateMatch(byWeight, byPieces);
  assert.ok(match.warnings.some((warning) => warning.includes("Нельзя автоматически сравнить 50 шт")));
  assert.equal(match.breakdown.find((item) => item.key === "minimumOrder")?.note, "Единицы измерения не совпадают");
});

test("distinguishes a minimum order with a missing unit from an absent minimum order", () => {
  const withoutUnit = makeSupplier({ minimumOrder: { text: "10000 — единица не определена" } });
  const match = calculateMatch(withoutUnit, { ...criteria, quantity: 1000, quantityUnit: "шт", requiresCertificates: false });
  assert.equal(match.breakdown.find((item) => item.key === "minimumOrder")?.note, "Единица минимального заказа не определена");
  assert.ok(match.warnings.some((warning) => warning.includes("единица не найдена")));
});

test("does not show a regional search result for another subject", () => {
  const moscowCriteria: SearchCriteria = { ...criteria, region: "Московская область", city: "Химки", requiresCertificates: false };
  assert.equal(supplierMatches(dairy, moscowCriteria), false);
});

test("unknown minimum order does not inflate completeness", () => {
  const withMoq = makeSupplier({ minimumOrder: { value: 50, unit: "кг", text: "от 50 кг" } });
  const withoutMoq = makeSupplier({ minimumOrder: { text: "Не указано" } });
  assert.ok(calculateCompleteness(withMoq) > calculateCompleteness(withoutMoq));
});

test("unknown minimum order earns no match points and scoring has a transparent breakdown", () => {
  const match = calculateMatch(dairy, criteria);
  const minimumOrder = match.breakdown.find((item) => item.key === "minimumOrder");
  assert.equal(minimumOrder?.earned, 0);
  assert.equal(minimumOrder?.max, 15);
  assert.match(minimumOrder?.note || "", /не найден/i);
});

test("manager checklist separates missing facts from routine checks", () => {
  const checklist = getManagerChecklist(dairy, criteria);
  assert.deepEqual(checklist.missingFacts.map((item) => item.id), ["price", "minimum-order", "documents", "contact"]);
  assert.ok(checklist.standardChecks.some((item) => item.id === "availability"));
});

test("outreach message asks for unknown facts", () => {
  const message = createOutreachMessage(dairy, criteria);
  assert.match(message, /моцарелла/i);
  assert.match(message, /минимальный объём заказа/i);
  assert.match(message, /сертификаты/i);
});
