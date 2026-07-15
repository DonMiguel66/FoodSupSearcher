import type { MatchBreakdownItem, MatchResult, SearchCriteria, Supplier } from "../types";
import { getManagerChecklist } from "./checklist";

const stopWords = new Set(["для", "нужен", "нужна", "нужно", "ищу", "оптом", "купить", "поставка", "поставщик", "с", "и", "в", "на"]);
const normalize = (value: string) => value.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/gi, " ").trim();
const tokens = (query: string) => normalize(query).split(" ").filter((token) => token.length > 2 && !stopWords.has(token));
const haystack = (supplier: Supplier) => normalize([supplier.name, supplier.description, ...supplier.categories, ...supplier.products].join(" "));
const servesRegion = (supplier: Supplier, region: string) => supplier.region === region || supplier.serviceAreas.includes(region) || supplier.serviceAreas.includes("Вся Россия");
const servesCity = (supplier: Supplier, criteria: SearchCriteria) => !criteria.city.trim() || supplier.city === criteria.city || supplier.serviceAreas.includes(criteria.city) || supplier.serviceAreas.includes("Вся Россия") || (supplier.region === criteria.region && supplier.serviceAreas.includes("Вся область"));

export function calculateCompleteness(supplier: Supplier) {
  const fields = [
    Boolean(supplier.description),
    supplier.products.length > 0,
    Boolean(supplier.minimumOrder.value),
    supplier.price.available,
    supplier.certificates.status !== "unknown",
    supplier.delivery.available !== null,
    Boolean(supplier.contacts.phone || supplier.contacts.email),
    Boolean(supplier.contacts.website),
    Boolean(supplier.source.url),
    Boolean(supplier.verifiedAt),
  ];
  return Math.round((fields.filter(Boolean).length / fields.length) * 100);
}

export function calculateMatch(supplier: Supplier, criteria: SearchCriteria): MatchResult {
  const breakdown: MatchBreakdownItem[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];
  const queryTokens = tokens(criteria.query);
  const text = haystack(supplier);
  let relevance = 0;

  if (criteria.category !== "Все категории" && supplier.categories.includes(criteria.category)) {
    if (queryTokens.length) {
      const matched = queryTokens.filter((token) => text.includes(token)).length;
      relevance = 15 + Math.round((matched / queryTokens.length) * 15);
      reasons.push(`Категория «${criteria.category}» совпадает`);
      if (matched) reasons.push(`В ассортименте найдено совпадений: ${matched}`);
    } else {
      relevance = 30;
      reasons.push(`Категория «${criteria.category}» совпадает`);
    }
  } else if (queryTokens.length) {
    const matched = queryTokens.filter((token) => text.includes(token)).length;
    relevance = Math.round((matched / queryTokens.length) * 30);
    if (matched) reasons.push(`В ассортименте найдено совпадений: ${matched}`);
  } else relevance = 24;
  breakdown.push({ key: "product", label: "Товар и категория", earned: relevance, max: 30, note: relevance === 30 ? "Точное совпадение" : relevance ? "Частичное совпадение" : "Совпадение не найдено" });

  let geography = 0;
  if (servesRegion(supplier, criteria.region) && !criteria.city.trim()) {
    geography = 20;
    reasons.push(`Работает в регионе «${criteria.region}»`);
  } else if (servesRegion(supplier, criteria.region) && servesCity(supplier, criteria)) {
    geography = 20;
    reasons.push(`Работает в населённом пункте ${criteria.city}`);
  } else if (supplier.delivery.available) geography = 12;
  breakdown.push({ key: "geography", label: "География", earned: geography, max: 20, note: geography === 20 ? "Регион или город подтверждён" : geography ? "Есть доставка, регион нужно уточнить" : "Связь с местом поставки не подтверждена" });

  if (criteria.quantity) {
    let moq = 0;
    let moqNote = "Не найден в источниках";
    if (supplier.minimumOrder.value && supplier.minimumOrder.unit === criteria.quantityUnit) {
      moq = supplier.minimumOrder.value <= criteria.quantity ? 15 : 0;
      moqNote = moq === 15 ? "Подходит под указанную потребность" : "Выше указанной потребности";
      if (moq === 15) reasons.push("Минимальный заказ подходит по объёму");
      else warnings.push("Минимальный заказ выше указанной потребности");
    } else if (supplier.minimumOrder.value && supplier.minimumOrder.unit) {
      moqNote = "Единицы измерения не совпадают";
      warnings.push(`Нельзя автоматически сравнить ${criteria.quantity} ${criteria.quantityUnit} и минимальный заказ «${supplier.minimumOrder.text}»`);
    } else if (!/не указан(?:о|а|ы)?|не найден(?:о|а|ы)?|нет данных|уточняется/i.test(supplier.minimumOrder.text)) {
      moqNote = "Единица минимального заказа не определена";
      warnings.push(`Минимальный заказ указан как «${supplier.minimumOrder.text}», но единица не найдена`);
    } else warnings.push("Минимальный заказ не найден в источниках");
    breakdown.push({ key: "minimumOrder", label: "Минимальный заказ", earned: moq, max: 15, note: moqNote });
  }

  if (criteria.requiresCertificates) {
    const cert = supplier.certificates.status === "confirmed" ? 10 : supplier.certificates.status === "partial" ? 5 : 0;
    breakdown.push({ key: "certificates", label: "Документы", earned: cert, max: 10, note: cert === 10 ? "Подтверждены источником" : cert ? "Упомянуты, комплект нужно запросить" : "Не найдены в источниках" });
    if (cert === 10) reasons.push("Документы подтверждены источником");
    else warnings.push("Комплект документов нужно запросить");
  }

  if (criteria.requiresDelivery) {
    const delivery = supplier.delivery.available === true ? 10 : 0;
    breakdown.push({ key: "delivery", label: "Доставка", earned: delivery, max: 10, note: delivery === 10 ? "Подтверждена" : delivery ? "Условия не подтверждены" : "Не найдена или недоступна" });
    if (delivery === 10) reasons.push("Доставка подтверждена");
    else warnings.push("Условия доставки нужно уточнить");
  }

  if (criteria.requiresPublishedPrice) {
    breakdown.push({ key: "price", label: "Публичная цена", earned: supplier.price.available ? 5 : 0, max: 5, note: supplier.price.available ? "Опубликована в источнике" : "Не найдена в источниках" });
    if (supplier.price.available) reasons.push("Цена опубликована в источнике");
    else warnings.push("Публичной цены нет");
  }

  // Подтверждённость данных всегда влияет на итог: в режиме веб-поиска все карточки
  // проходят фильтр по товару и региону, поэтому без этого блока итоговая оценка
  // упиралось бы в ~100% даже у карточек, где почти ничего не удалось подтвердить.
  const verifiableFacts = [
    supplier.minimumOrder.value !== undefined,
    supplier.price.available,
    supplier.certificates.status !== "unknown",
    supplier.delivery.available !== null,
    Boolean(supplier.contacts.phone || supplier.contacts.email),
  ].filter(Boolean).length;
  const dataEarned = Math.round((verifiableFacts / 5) * 25);
  breakdown.push({ key: "data", label: "Подтверждённость данных", earned: dataEarned, max: 25, note: `Подтверждено ключевых условий: ${verifiableFacts} из 5` });
  if (verifiableFacts >= 4) reasons.push("Большинство условий подтверждено источниками");
  else if (verifiableFacts <= 1) warnings.push("По компании подтверждено мало данных");

  const completeness = calculateCompleteness(supplier);
  const earned = breakdown.reduce((sum, item) => sum + item.earned, 0);
  const max = breakdown.reduce((sum, item) => sum + item.max, 0);
  if (!supplier.price.available && !warnings.some((warning) => warning.includes("цен"))) warnings.push("Цена по запросу");
  return { score: Math.max(0, Math.min(100, Math.round((earned / max) * 100))), completeness, breakdown, reasons: reasons.slice(0, 4), warnings: warnings.slice(0, 3) };
}

export function supplierMatches(supplier: Supplier, criteria: SearchCriteria) {
  const queryTokens = tokens(criteria.query);
  const text = haystack(supplier);
  return (
    (!queryTokens.length || queryTokens.some((token) => text.includes(token))) &&
    (criteria.category === "Все категории" || supplier.categories.includes(criteria.category)) &&
    servesRegion(supplier, criteria.region) &&
    servesCity(supplier, criteria) &&
    (!criteria.requiresCertificates || supplier.certificates.status !== "unknown") &&
    (!criteria.requiresDelivery || supplier.delivery.available === true) &&
    (!criteria.requiresPublishedPrice || supplier.price.available)
  );
}

export function commercialEvidenceCount(supplier: Supplier): number {
  return [
    supplier.minimumOrder.value !== undefined,
    supplier.price.available,
    supplier.delivery.available === true,
    Boolean(supplier.contacts.phone || supplier.contacts.email),
  ].filter(Boolean).length;
}

export function compareRankedSuppliers(left: { supplier: Supplier; match: MatchResult }, right: { supplier: Supplier; match: MatchResult }): number {
  return right.match.score - left.match.score
    || right.match.completeness - left.match.completeness
    || commercialEvidenceCount(right.supplier) - commercialEvidenceCount(left.supplier)
    || left.supplier.name.localeCompare(right.supplier.name, "ru");
}

export function createOutreachMessage(supplier: Supplier, criteria: SearchCriteria) {
  const product = criteria.query.trim() || criteria.category.toLocaleLowerCase("ru-RU");
  const quantity = criteria.quantity ? ` Ориентировочный объём — ${criteria.quantity} ${criteria.quantityUnit}.` : "";
  const questions = getManagerChecklist(supplier, criteria).missingFacts.map((item) => item.question.replace(/^(Запросить|Уточнить|Найти)\s+/i, "").replace(/[.]$/, "").toLocaleLowerCase("ru-RU"));
  return `Здравствуйте!\n\nРассматриваем ${supplier.name} как потенциального поставщика. Нас интересует: ${product}.${quantity}\n\nПодскажите, пожалуйста, ${questions.length ? questions.join(", ") : "актуальные условия сотрудничества и срок ближайшей поставки"}. Также будем благодарны за коммерческое предложение и прайс-лист.\n\nСпасибо! Будем ждать обратной связи.`;
}
