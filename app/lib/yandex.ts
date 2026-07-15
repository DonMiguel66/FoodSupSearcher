import { z } from "zod";
import { domainToUnicode } from "node:url";
import { categories } from "../data/categories";
import type { Category, SearchCriteria, Supplier, SupplierFactKey, SupplierSource } from "../types";
import { canonicalUrl } from "./source-enrichment";

const evidenceFields = ["minimumOrder", "price", "certificates", "delivery", "contacts"] as const;
const evidenceSchema = z.object({
  field: z.enum(evidenceFields),
  sourceUrl: z.string().max(500),
});

const candidateSchema = z.object({
  name: z.string().min(2).max(160),
  region: z.string().min(2).max(100),
  city: z.string().min(2).max(100),
  description: z.string().min(10).max(600),
  categories: z.array(z.enum(categories)).min(1).max(3),
  products: z.array(z.string().min(2).max(100)).min(1).max(12),
  serviceAreas: z.array(z.string().min(2).max(100)).min(1).max(12),
  minimumOrder: z.string().min(2).max(160),
  price: z.string().min(2).max(160),
  certificates: z.string().min(2).max(220),
  delivery: z.string().min(2).max(220),
  website: z.string().max(500),
  phone: z.string().max(60),
  email: z.string().max(160),
  sourceUrls: z.array(z.string().max(500)).min(1).max(8),
  evidence: z.array(evidenceSchema).max(10),
});

const resultSchema = z.object({ suppliers: z.array(candidateSchema).max(8) });

export const supplierResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["suppliers"],
  properties: {
    suppliers: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "region", "city", "description", "categories", "products", "serviceAreas", "minimumOrder", "price", "certificates", "delivery", "website", "phone", "email", "sourceUrls", "evidence"],
        properties: {
          name: { type: "string" },
          region: { type: "string" },
          city: { type: "string" },
          description: { type: "string" },
          categories: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: categories } },
          products: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" } },
          serviceAreas: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" } },
          minimumOrder: { type: "string" },
          price: { type: "string" },
          certificates: { type: "string" },
          delivery: { type: "string" },
          website: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          sourceUrls: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
          evidence: {
            type: "array",
            maxItems: 10,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["field", "sourceUrl"],
              properties: {
                field: { type: "string", enum: evidenceFields },
                sourceUrl: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

export type Citation = { url: string; title: string; confidence?: "high" | "medium" | "low"; excerpt?: string };

function criteriaPrompt(criteria: SearchCriteria): string {
  const quantity = criteria.quantity ? `${criteria.quantity} ${criteria.quantityUnit}` : "не указан";
  const category = criteria.category === "Все категории" ? "определи автоматически по товару из запроса" : criteria.category;
  return [
    `Найди до 8 реальных поставщиков продуктов питания, напитков или упаковки, которые работают или подтверждённо доставляют в субъект РФ «${criteria.region}». Если надёжных кандидатов меньше, верни только подтверждённых.`,
    `Запрос: ${criteria.query || criteria.category}. Категория: ${category}. Населённый пункт доставки: ${criteria.city.trim() || "не указан, искать по всему субъекту"}. Потребность: ${quantity}.`,
    `Нужны документы: ${criteria.requiresCertificates ? "да" : "нет"}; доставка: ${criteria.requiresDelivery ? "да" : "нет"}; публичная цена: ${criteria.requiresPublishedPrice ? "да" : "нет"}.`,
    "Используй веб-поиск. Предпочитай официальные сайты компаний, каталоги и страницы с контактами. Не включай агрегаторы без подтверждения существования компании.",
    "Для каждого поставщика найди контактный телефон и e-mail с официального сайта или страницы контактов, если они опубликованы.",
  ].join("\n");
}

export function createYandexSearchRequest(criteria: SearchCriteria, folderId: string, model: string) {
  return {
    model: `gpt://${folderId}/${model}`,
    instructions: [
      "Ты аналитик закупок. Отвечай по-русски.",
      "Не придумывай поставщиков, контакты, цены, минимальный заказ, документы или доставку.",
      "Определи товарную категорию автоматически по тексту запроса; пользователь не обязан выбирать её вручную.",
      "Собери до 8 кандидатов, если источники это позволяют. Для каждого кратко перечисли найденные факты и опирайся только на веб-источники.",
      "Используй поисковые вызовы последовательно: сначала сделай несколько вариантов запроса по товару и региону, затем проверь официальные страницы товара, каталога или прайс-листа, после этого — доставку, документы и контакты. Чередуй слова «оптом», «поставщик», «производитель», «прайс», «цена», «минимальный заказ», название города и субъекта РФ. Каталоги организаций и карты используй только как подсказку для поиска официального сайта, а не как итоговый источник карточки.",
      "Не считай компанию подходящей только из-за совпадения её названия с запросом. Источник должен явно подтверждать нужный товар и производство, оптовую продажу или поставку.",
      "Для каждого кандидата проверь связь с указанным субъектом РФ: местонахождение, филиал, склад, зона доставки или явно заявленные поставки. Не подменяй выбранный субъект одноимённым городом в другом регионе.",
      "В поле city указывай только фактическое местонахождение офиса, склада или производства из источника. Не копируй туда город доставки; если местонахождение не найдено, укажи «Не указано».",
      "Проверяй, что используемая страница существует. Предпочитай официальный сайт, активный каталог производителя или страницу с ассортиментом; реестры юрлиц используй только как дополнительное подтверждение.",
      "Для name используй официальное название компании, бренд или название сайта. Никогда не пиши в name «Не указано»: если юридическое название не найдено, возьми узнаваемое название из заголовка официального сайта или его домена.",
      "Если факт не найден, укажи «Не указано». Не делай выводов сверх найденного.",
    ].join(" "),
    input: criteriaPrompt(criteria),
    tools: [{ type: "web_search", search_context_size: "high" }],
    tool_choice: "required",
    max_tool_calls: 5,
    temperature: 0.1,
    max_output_tokens: 5000,
  };
}

export function createYandexStructureRequest(criteria: SearchCriteria, folderId: string, model: string, searchText: string, citations: Citation[]) {
  const sourceList = citations.slice(0, 30).map((citation, index) => `${index + 1}. ${citation.title}: ${citation.url}`).join("\n");
  return {
    model: `gpt://${folderId}/${model}`,
    instructions: [
      "Ты преобразуешь результаты уже выполненного веб-поиска в JSON. Новый поиск не выполняй.",
      "Используй только факты из переданного текста и только URL из списка разрешённых источников.",
      "Не придумывай поставщиков, контакты или условия. Если факт не найден, укажи «Не указано».",
      "Поля phone и email заполняй только реальными контактами из переданного текста; если их нет — «Не указано».",
      "В evidence укажи URL источника для каждого подтверждённого условия. Не добавляй evidence для факта, которого нет в источнике.",
      `Поле region каждого кандидата заполняй точным значением «${criteria.region}» только при наличии подтверждённой связи с этим субъектом.`,
      "В name укажи официальное название компании, бренд или узнаваемое название официального сайта; значение «Не указано» для name запрещено.",
      "Если minimumOrder найден как денежная сумма, обязательно сохрани валюту. Не превращай сумму заказа в штуки, килограммы или литры.",
      "Если price содержит список цен каталога, выбери только цену запрошенного товара. Если связь конкретной цены с товаром не подтверждена, укажи «Прайс опубликован, точная цена товара не извлечена».",
      "Категории выбирай только из перечисления схемы. Из найденных кандидатов верни не более восьми поставщиков с наиболее полными и надёжно подтверждёнными сведениями.",
    ].join(" "),
    input: [
      criteriaPrompt(criteria),
      "\nРезультат веб-поиска:\n" + searchText.slice(0, 24_000),
      "\nРазрешённые источники:\n" + sourceList,
    ].join("\n"),
    temperature: 0.1,
    max_output_tokens: 5000,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "supplier_search_result",
        strict: true,
        schema: supplierResultJsonSchema,
      },
    },
  };
}

export function createYandexEnrichmentRequest(
  criteria: SearchCriteria,
  folderId: string,
  model: string,
  suppliers: Supplier[],
  documents: Array<{ supplierName: string; url: string; title: string; mediaType: string; text: string }>,
) {
  const documentText = documents.map((document, index) => [
    `ИСТОЧНИК ${index + 1}`,
    `Поставщик: ${document.supplierName}`,
    `URL: ${document.url}`,
    `Тип: ${document.mediaType}`,
    `Заголовок: ${document.title}`,
    document.text.slice(0, 5_000),
  ].join("\n")).slice(0, 15).join("\n\n---\n\n");
  const preliminary = suppliers.map((supplier) => ({
    name: supplier.name,
    region: supplier.region,
    city: supplier.city,
    description: supplier.description,
    categories: supplier.categories,
    products: supplier.products,
    serviceAreas: supplier.serviceAreas,
    minimumOrder: supplier.minimumOrder.text,
    price: supplier.price.text,
    certificates: supplier.certificates.text,
    delivery: supplier.delivery.text,
    website: supplier.contacts.website,
    phone: supplier.contacts.phone ?? "Не указано",
    email: supplier.contacts.email ?? "Не указано",
    sourceUrls: supplier.sources.map((source) => source.url),
  }));
  return {
    model: `gpt://${folderId}/${model}`,
    instructions: [
      "Ты уточняешь уже найденные карточки поставщиков по содержимому официальных страниц и прайс-листов. Отвечай по-русски.",
      "Не добавляй новых поставщиков и не объединяй разные компании. Сохрани только поставщиков из предварительного списка.",
      "Используй только факты из переданных источников. Если новый источник не уточняет поле, сохрани подтверждённое предварительное значение или укажи «Не указано».",
      "Точную цену указывай только когда она относится к товару из запроса. Не подменяй цену товара порогом бесплатной доставки или общей суммой заказа и не копируй перечень цен всего каталога.",
      "В поле price сохраняй сумму, валюту и базу цены ровно в том виде, в котором они подтверждены источником: «от N ₽/кг», «N–M руб. за упаковку», «N ₽ за 100 г». Не переноси значения из этих шаблонов в ответ. Число без подтверждённой валюты недопустимо.",
      "Учитывай обозначения ₽, руб., р., RUB/RUR, а также другие явно указанные валюты; единица может быть записана через «/», «за», фасовку или код unitText/unitCode. Если у точного товара несколько вариантов, оставь не более трёх цен и подпиши фасовку или условие каждой.",
      "Не подменяй минимальный заказ минимальным весом доставки. Для минимального заказа всегда сохраняй единицу или валюту из источника: например, «10 000 ₽», а не «10000». Если найден только опубликованный прайс без строки нужного товара, напиши «Прайс-лист опубликован, точная цена товара не извлечена».",
      "Сохрани или восстанови официальное имя поставщика из заголовка сайта либо домена; значение «Не указано» в name запрещено.",
      "В поле delivery не отвечай только «Да» или «Нет»: сохрани опубликованную географию, порог, стоимость или способ доставки. Если подробностей нет, напиши «Доставка заявлена, условия не указаны».",
      "Для XLSX используй строки по запросу вместе с заголовками таблицы. Учитывай единицу цены, фасовку и дату прайса, если они указаны.",
      "В sourceUrls включай только точные URL из блоков ИСТОЧНИК. Сначала ставь наиболее предметную страницу товара или прайса.",
      "В evidence добавляй отдельную запись для каждого подтверждённого поля minimumOrder, price, certificates, delivery и contacts с точным URL источника. Не добавляй evidence для неизвестного поля.",
    ].join(" "),
    input: [
      criteriaPrompt(criteria),
      "\nПредварительные карточки:\n" + JSON.stringify(preliminary),
      "\nСодержимое официальных источников:\n" + documentText,
    ].join("\n"),
    temperature: 0.1,
    max_output_tokens: 6000,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "enriched_supplier_search_result",
        strict: true,
        schema: supplierResultJsonSchema,
      },
    },
  };
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const normalized = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
    const url = new URL(normalized);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function host(value: string): string {
  try { return new URL(value).hostname.replace(/^www\./, "").toLocaleLowerCase("ru-RU"); }
  catch { return ""; }
}

function extractTextAndCitations(payload: unknown): { text: string; citations: Citation[] } {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const texts: string[] = [];
  const citations = new Map<string, Citation>();
  const addCitation = (urlValue: unknown, titleValue: unknown) => {
    const url = safeHttpUrl(urlValue);
    if (url) citations.set(url, { url, title: typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : host(url) });
  };

  if (typeof root.output_text === "string") texts.push(root.output_text);
  const output = Array.isArray(root.output) ? root.output : [];
  for (const itemValue of output) {
    if (!itemValue || typeof itemValue !== "object") continue;
    const item = itemValue as Record<string, unknown>;
    const action = item.action && typeof item.action === "object" ? item.action as Record<string, unknown> : null;
    if (action && Array.isArray(action.sources)) {
      for (const source of action.sources) {
        if (source && typeof source === "object") {
          const entry = source as Record<string, unknown>;
          addCitation(entry.url, entry.title);
        }
      }
    }
    if (!Array.isArray(item.content)) continue;
    for (const blockValue of item.content) {
      if (!blockValue || typeof blockValue !== "object") continue;
      const block = blockValue as Record<string, unknown>;
      if (block.type === "output_text" && typeof block.text === "string") texts.push(block.text);
      if (Array.isArray(block.annotations)) {
        for (const annotation of block.annotations) {
          if (annotation && typeof annotation === "object") {
            const entry = annotation as Record<string, unknown>;
            if (entry.type === "url_citation") addCitation(entry.url, entry.title);
          }
        }
      }
    }
  }
  return { text: texts.at(-1)?.trim() || "", citations: [...citations.values()] };
}

export function parseYandexSearchResponse(payload: unknown): { text: string; citations: Citation[] } {
  const result = extractTextAndCitations(payload);
  if (!result.text) throw new Error("YANDEX_EMPTY_SEARCH_RESPONSE");
  if (!result.citations.length) throw new Error("YANDEX_SEARCH_WITHOUT_CITATIONS");
  return result;
}

const unknown = (value: string) => /^(?:нет|неизвестн(?:о|а|ы|ен)?|отсутствуют?)$|не указан(?:о|а|ы)?|не найден(?:о|а|ы)?|нет данных|уточняется/i.test(value.trim());

function sanitizeEmail(value: string): string | undefined {
  const trimmed = value.trim();
  if (unknown(trimmed)) return undefined;
  const match = trimmed.match(/[^\s@<>()"]+@[^\s@<>()"]+\.[a-zа-я]{2,}/i);
  return match ? match[0].toLocaleLowerCase("ru-RU") : undefined;
}

function sanitizePhone(value: string): string | undefined {
  const trimmed = value.trim();
  if (unknown(trimmed)) return undefined;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return undefined;
  const formatted = trimmed.match(/\+?[\d()\-.\s]{10,25}/);
  return formatted ? formatted[0].trim() : undefined;
}

function minimumOrder(value: string): Supplier["minimumOrder"] {
  const match = value.match(/(\d[\d\s]*(?:[.,]\d+)?)\s*(кг|л|шт(?:\.|ука|уки|ук)?|упак(?:\.|овка|овки|овок)?|₽|руб(?:\.|л(?:ь|я|ей)?)?)/i);
  if (!match) return { text: value };
  const rawUnit = match[2].toLocaleLowerCase("ru-RU");
  const unit = rawUnit.startsWith("руб") ? "₽" : rawUnit.startsWith("шт") ? "шт" : rawUnit.startsWith("упак") ? "упак" : rawUnit as Supplier["minimumOrder"]["unit"];
  return { value: Number(match[1].replace(/\s/g, "").replace(",", ".")), unit, text: value };
}

function makeId(name: string, url: string): string {
  const slug = name.toLocaleLowerCase("ru-RU").replace(/[^a-zа-я0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 42) || "supplier";
  let hash = 2166136261;
  for (const char of `${name}|${url}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `live-${slug}-${(hash >>> 0).toString(36)}`;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Yekaterinburg" }).format(date);
}

function isPlatformName(value: string): boolean {
  return /^(авито|avito|ozon|wildberries|вайлдберриз|яндекс(?:\s+маркет)?|2гис|checko|чекко|restoranica|пульсцен|pulscen|productcenter|продуктцентр)$/i.test(value.trim());
}

function supplierName(value: string, url: string, citation?: Citation): string {
  const current = value.trim();
  if (!unknown(current)) return current;

  const segments = (citation?.title || "")
    .split(/\s+(?:\||[–—]|-)\s+/)
    .map((segment) => segment.replace(/\s+/g, " ").trim())
    .filter((segment) => segment.length >= 2 && segment.length <= 100)
    .filter((segment) => !/^(?:главная|каталог|товары|продукция|купить|цена|прайс|интернет[- ]магазин|официальный сайт|страница не найдена|404)(?:\b|\s|:)/i.test(segment));
  const legalName = segments.find((segment) => /(?:^|\s)(?:ООО|АО|ПАО|ИП|ТД|ТК|ГК)(?:\s|[«"])/i.test(segment));
  const titleName = legalName || segments.at(-1);
  if (titleName && !unknown(titleName)) return titleName;

  const hostname = domainToUnicode(host(url));
  const label = hostname.split(".")[0]?.replace(/[-_]+/g, " ").trim();
  return label && !/^xn--/i.test(label) ? label : "Поставщик с подтверждённым сайтом";
}

function isAggregatorHost(value: string): boolean {
  return /(^|\.)(?:agroserver|avito|allbiz|bizorg|checko|list-org|optlist|ozon|productcenter|pulscen|regtorg|restoranica|rusprofile|tiu|2gis|wildberries|yandex)\.(?:ru|com|by|kz)$/i.test(value);
}

function currencySymbol(value: string): string | undefined {
  if (/(?:₽|\bRU[BR]\b|руб(?:\.|л(?:ь|я|ей)?)?(?=$|[\s/.,;:)])|(?:^|[\s\d])р\.(?=\s|\/|$))/i.test(value)) return "₽";
  if (/(?:\$|\bUSD\b|долл(?:\.|ар(?:а|ов)?)?)/i.test(value)) return "$";
  if (/(?:€|\bEUR\b|евро)/i.test(value)) return "€";
  if (/(?:₸|\bKZT\b|тенге)/i.test(value)) return "₸";
  if (/(?:¥|\bCNY\b|юан(?:ь|я|ей)?)/i.test(value)) return "¥";
  return undefined;
}

function canonicalPriceUnit(value: string): string | undefined {
  const normalized = value.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\.$/, "");
  if (/^(?:кг|килограмм)/.test(normalized)) return "кг";
  if (/^(?:г|гр|грамм)/.test(normalized)) return "г";
  if (/^(?:л|литр)/.test(normalized)) return "л";
  if (/^(?:мл|миллилитр)/.test(normalized)) return "мл";
  if (/^(?:шт|штук)/.test(normalized)) return "шт.";
  if (/^(?:уп|упак)/.test(normalized)) return "упак.";
  if (/^(?:кор|короб)/.test(normalized)) return "короб";
  if (/^пач/.test(normalized)) return "пачку";
  if (/^бутыл/.test(normalized)) return "бутылку";
  if (/^банк/.test(normalized)) return "банку";
  if (/^меш/.test(normalized)) return "мешок";
  if (/^(?:т|тонн)/.test(normalized)) return "т";
  if (/^палл/.test(normalized)) return "паллету";
  return undefined;
}

function priceBasis(value: string): string {
  const unitPattern = "кг|килограмм(?:а|ов)?|грамм(?:а|ов)?|гр\\.?|г|мл|миллилитр(?:а|ов)?|л|литр(?:а|ов)?|шт\\.?|штук(?:а|и)?|упак\\.?|упаковк(?:а|у|и)|кор\\.?|короб(?:ка|ку|ки)?|пачк(?:а|у|и)|бутылк(?:а|у|и)|банк(?:а|у|и)|меш(?:ок|ка|ков)|т|тонн(?:а|ы)?|палл(?:ета|ету|еты)";
  const explicit = new RegExp(`(?:\\/|(?:^|\\s)за\\s+)(?:(\\d+(?:[.,]\\d+)?)\\s*)?(${unitPattern})(?=$|[\\s.,;:)])`, "i").exec(value);
  if (explicit) {
    const unit = canonicalPriceUnit(explicit[2]);
    if (!unit) return "";
    return explicit[1] ? ` за ${explicit[1]} ${unit}` : `/${unit}`;
  }
  const unitText = /["'](?:unitText|measureSymbol)["']\s*:\s*["']([^"']+)["']/i.exec(value)?.[1];
  const structuredUnit = unitText ? canonicalPriceUnit(unitText) : undefined;
  if (structuredUnit) return `/${structuredUnit}`;
  const unitCode = /["']unitCode["']\s*:\s*["'](KGM|GRM|LTR|MLT|H87|EA)["']/i.exec(value)?.[1]?.toLocaleUpperCase("en-US");
  return unitCode ? `/${({ KGM: "кг", GRM: "г", LTR: "л", MLT: "мл", H87: "шт.", EA: "шт." } as Record<string, string>)[unitCode]}` : "";
}

function sourceContextForPrice(excerpt: string, price: string): string {
  const normalizedExcerpt = excerpt.replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ");
  const normalizedPrice = price.replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ");
  let index = normalizedExcerpt.toLocaleLowerCase("ru-RU").indexOf(normalizedPrice.toLocaleLowerCase("ru-RU"));
  if (index < 0) {
    const firstNumber = normalizedPrice.match(/\d[\d\s.,]*/)?.[0]?.replace(/[\s.,]/g, "");
    if (firstNumber && firstNumber.length >= 2) {
      const flexible = new RegExp(`(?<!\\d)${[...firstNumber].join("[\\s.,]?")}(?!\\d)`);
      index = flexible.exec(normalizedExcerpt)?.index ?? -1;
    }
  }
  if (index >= 0) return normalizedExcerpt.slice(Math.max(0, index - 180), index + normalizedPrice.length + 180);
  const structured = normalizedExcerpt.match(/.{0,180}["'](?:price|lowPrice|highPrice)["']\s*:\s*["'][^"']+["'].{0,240}/i)?.[0];
  return structured || "";
}

function priceWithSourceContext(value: string, citation?: Citation): string {
  const trimmed = value.trim().replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ");
  if (unknown(trimmed) || currencySymbol(trimmed)) return trimmed;
  const amount = "(?:\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})+|\\d+)(?:[.,]\\d{1,2})?";
  if (!new RegExp(`^(?:от\\s+|до\\s+)?${amount}(?:\\s*(?:[-–—]|до)\\s*${amount})?$`, "i").test(trimmed)) return trimmed;
  const excerpt = citation?.excerpt || "";
  const context = sourceContextForPrice(excerpt, trimmed);
  const structuredCurrency = /["']priceCurrency["']\s*:\s*["']([^"']+)["']/i.exec(excerpt)?.[1] || "";
  const currency = currencySymbol(context) || currencySymbol(structuredCurrency);
  if (!currency) return trimmed;
  const basis = priceBasis(context) || priceBasis(excerpt);
  return `${trimmed} ${currency}${basis}`;
}

function normalizedPrice(value: string, citation?: Citation): Supplier["price"] {
  const text = priceWithSourceContext(value, citation);
  const amounts = text.match(/\d[\d\s]*(?:[.,]\d+)?/g) || [];
  const currencyMentions = text.match(/₽|\bRU[BR]\b|руб(?:\.|л(?:ь|я|ей)?)?|\$|\bUSD\b|€|\bEUR\b|₸|\bKZT\b|¥|\bCNY\b/gi) || [];
  const catalogList = text.length > 125 || amounts.length > 3 || currencyMentions.length > 3;
  if (catalogList) {
    return { available: false, text: "В источнике несколько цен — точную цену товара нужно проверить" };
  }
  return { available: /\d/.test(text) && Boolean(currencySymbol(text)), text };
}

function minimumOrderWithSourceContext(value: string, citation?: Citation): string {
  const trimmed = value.trim().replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ");
  if (unknown(trimmed) || minimumOrder(trimmed).unit) return trimmed;
  const amount = trimmed.match(/\d[\d\s]*(?:[.,]\d+)?/)?.[0];
  if (!amount || !/^(?:от\s+)?\d[\d\s]*(?:[.,]\d+)?$/i.test(trimmed)) return trimmed;

  const context = sourceContextForPrice(citation?.excerpt || "", amount);
  if (!/(?:минимальн[а-яё]*\s+(?:заказ|сумм)|заказ\s+от|минимум\s+(?:заказа|к заказу))/i.test(context)) {
    return `${trimmed} — единица не определена`;
  }
  const currency = currencySymbol(context);
  if (currency) return `${trimmed} ${currency}`;

  const digits = amount.replace(/\D/g, "");
  const flexibleAmount = digits ? [...digits].join("[\\s.,]?") : "";
  const unitMatch = flexibleAmount
    ? new RegExp(`${flexibleAmount}\\s*(кг|л|шт(?:\\.|ука|уки|ук)?|упак(?:\\.|овка|овки|овок)?)`, "i").exec(context)
    : null;
  if (unitMatch) return `${trimmed} ${unitMatch[1]}`;
  return `${trimmed} — единица не определена`;
}

export function parseYandexResponse(payload: unknown, now = new Date(), externalCitations: Citation[] = []): { suppliers: Supplier[]; citations: Citation[] } {
  const extracted = extractTextAndCitations(payload);
  const citationMap = new Map<string, Citation>();
  for (const citation of [...externalCitations, ...extracted.citations]) citationMap.set(citation.url, citation);
  const citations = [...citationMap.values()];
  const text = extracted.text;
  if (!text) throw new Error("YANDEX_EMPTY_RESPONSE");
  let decoded: unknown;
  try { decoded = JSON.parse(text); }
  catch { throw new Error("YANDEX_INVALID_JSON"); }
  const parsed = resultSchema.parse(decoded);
  const citationsByUrl = new Map(citations.map((citation) => [canonicalUrl(citation.url), citation]));
  const checkedAt = formatDate(now);
  const seen = new Set<string>();

  const suppliers = parsed.suppliers.flatMap((candidate): Supplier[] => {
    const candidateUrls = [...candidate.sourceUrls, candidate.website].map(safeHttpUrl).filter((url): url is string => Boolean(url));
    const citedUrls = [...new Set(candidateUrls.filter((url) => citationsByUrl.has(canonicalUrl(url))).map(canonicalUrl))];
    const confirmedUrls = citedUrls.filter((url) => !isAggregatorHost(host(url)));
    if (!confirmedUrls.length) return [];
    const sourceUrl = confirmedUrls[0];
    const name = supplierName(candidate.name, sourceUrl, citationsByUrl.get(canonicalUrl(sourceUrl)));
    if (isPlatformName(name)) return [];
    const key = host(sourceUrl);
    if (seen.has(key)) return [];
    seen.add(key);
    const sourceForUrl = (url: string): SupplierSource => {
      const citation = citationsByUrl.get(canonicalUrl(url));
      return {
        url,
        title: citation?.title || host(url),
        publisher: host(url),
        checkedAt,
        confidence: citation?.confidence || "medium",
      };
    };
    const sources = confirmedUrls.map(sourceForUrl);
    const factSources: Supplier["factSources"] = {};
    const evidenceValue: Record<SupplierFactKey, string> = {
      minimumOrder: candidate.minimumOrder,
      price: candidate.price,
      certificates: candidate.certificates,
      delivery: candidate.delivery,
      contacts: [candidate.phone, candidate.email].every((value) => !value.trim() || unknown(value)) ? "Не указано" : `${candidate.phone} ${candidate.email}`,
    };
    for (const evidence of candidate.evidence) {
      if (unknown(evidenceValue[evidence.field as SupplierFactKey])) continue;
      const url = safeHttpUrl(evidence.sourceUrl);
      if (!url) continue;
      const canonical = canonicalUrl(url);
      if (!confirmedUrls.includes(canonical)) continue;
      factSources[evidence.field as SupplierFactKey] = sourceForUrl(canonical);
    }
    const deliveryUnknown = unknown(candidate.delivery);
    const deliveryNegative = /(^|\s)(нет|не осуществ|самовывоз)/i.test(candidate.delivery);
    const phone = sanitizePhone(candidate.phone);
    const email = sanitizeEmail(candidate.email);
    if (sources.length === 1) {
      if (!unknown(candidate.minimumOrder) && !factSources.minimumOrder) factSources.minimumOrder = sources[0];
      if (!unknown(candidate.price) && !factSources.price) factSources.price = sources[0];
      if (!unknown(candidate.certificates) && !factSources.certificates) factSources.certificates = sources[0];
      if (!unknown(candidate.delivery) && !factSources.delivery) factSources.delivery = sources[0];
      if ((phone || email) && !factSources.contacts) factSources.contacts = sources[0];
    }
    const priceSource = factSources.price ? citationsByUrl.get(canonicalUrl(factSources.price.url)) : sources.length === 1 ? citationsByUrl.get(canonicalUrl(sources[0].url)) : undefined;
    const minimumOrderSource = factSources.minimumOrder ? citationsByUrl.get(canonicalUrl(factSources.minimumOrder.url)) : sources.length === 1 ? citationsByUrl.get(canonicalUrl(sources[0].url)) : undefined;
    const price = normalizedPrice(candidate.price, priceSource);
    const normalizedMinimumOrder = minimumOrderWithSourceContext(candidate.minimumOrder, minimumOrderSource);
    return [{
      id: makeId(name, sourceUrl),
      name,
      region: candidate.region,
      city: candidate.city,
      description: candidate.description,
      categories: candidate.categories as Category[],
      products: candidate.products,
      serviceAreas: candidate.serviceAreas,
      minimumOrder: minimumOrder(normalizedMinimumOrder),
      price,
      certificates: { status: unknown(candidate.certificates) ? "unknown" : "partial", text: candidate.certificates },
      delivery: { available: deliveryUnknown ? null : !deliveryNegative, text: candidate.delivery },
      contacts: { website: confirmedUrls.find((url) => host(url) === host(candidate.website)) || sourceUrl, ...(phone ? { phone } : {}), ...(email ? { email } : {}) },
      source: sources[0],
      sources,
      factSources,
      verifiedAt: checkedAt,
      origin: "live",
    }];
  });
  return { suppliers, citations };
}
