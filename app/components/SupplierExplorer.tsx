"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { categories } from "../data/categories";
import { russianRegions, type RussianRegion } from "../data/regions";
import { getManagerChecklist } from "../lib/checklist";
import { calculateMatch, commercialEvidenceCount, compareRankedSuppliers, createOutreachMessage, supplierMatches } from "../lib/matching";
import type { SearchCriteria, Supplier, SupplierSource } from "../types";

const initialCriteria: SearchCriteria = { query: "", category: "Все категории", region: "", city: "", quantityUnit: "кг", requiresCertificates: false, requiresDelivery: false, requiresPublishedPrice: false };
const quantityUnits: SearchCriteria["quantityUnit"][] = ["кг", "л", "шт", "упак"];
type SortMode = "match" | "complete" | "name";
type ResearchResult = { provider: "yandex"; model: string; searchedAt: string; cached: boolean; count: number };
type SearchHistoryEntry = { id: string; criteria: SearchCriteria; suppliers: Supplier[]; result: ResearchResult };
type AccessStatus = "checking" | "required" | "granted";
const MAX_HISTORY_ENTRIES = 8;

function publicSearchError(message: string): string {
  return message
    .replace(/Yandex AI Studio/gi, "Провайдер интернет-поиска")
    .replace(/Yandex Cloud Function/gi, "серверную функцию")
    .replace(/Yandex/gi, "Провайдер интернет-поиска")
    .replace(/folder ID/gi, "идентификатор каталога");
}

async function verifyRemoteAccess(discoverEndpoint: string, accessCode: string): Promise<void> {
  if (!discoverEndpoint) throw new Error("Публичный endpoint поиска ещё не настроен.");
  const response = await fetch(discoverEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "verify-access", accessCode: accessCode.trim() }),
  });
  const payload = await response.json() as { error?: string };
  if (!response.ok) throw new Error(payload.error || "Не удалось проверить код доступа.");
}

function sanitizeCriteria(value: unknown): SearchCriteria {
  if (!value || typeof value !== "object" || Array.isArray(value)) return initialCriteria;
  const saved = value as Partial<SearchCriteria>;
  const quantity = typeof saved.quantity === "number" && Number.isFinite(saved.quantity) && saved.quantity > 0 && saved.quantity <= 1_000_000
    ? saved.quantity
    : undefined;
  return {
    query: typeof saved.query === "string" ? saved.query.slice(0, 160) : "",
    category: "Все категории",
    region: typeof saved.region === "string" && russianRegions.includes(saved.region as RussianRegion) ? saved.region : "",
    city: typeof saved.city === "string" && saved.city !== "Вся область" ? saved.city.slice(0, 80) : "",
    quantity,
    quantityUnit: quantityUnits.includes(saved.quantityUnit as SearchCriteria["quantityUnit"]) ? saved.quantityUnit as SearchCriteria["quantityUnit"] : "кг",
    requiresCertificates: saved.requiresCertificates === true,
    requiresDelivery: saved.requiresDelivery === true,
    requiresPublishedPrice: saved.requiresPublishedPrice === true,
  };
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
}

function isStoredSource(value: unknown): value is SupplierSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Partial<SupplierSource>;
  return isHttpUrl(source.url)
    && typeof source.title === "string"
    && typeof source.publisher === "string"
    && typeof source.checkedAt === "string"
    && ["high", "medium", "low"].includes(source.confidence || "");
}

function isStoredSupplier(value: unknown): value is Supplier {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const supplier = value as Partial<Supplier>;
  return typeof supplier.id === "string"
    && typeof supplier.name === "string"
    && typeof supplier.region === "string"
    && typeof supplier.city === "string"
    && typeof supplier.description === "string"
    && Array.isArray(supplier.categories)
    && supplier.categories.every((category) => categories.includes(category))
    && Array.isArray(supplier.products)
    && supplier.products.every((product) => typeof product === "string")
    && Array.isArray(supplier.serviceAreas)
    && supplier.serviceAreas.every((area) => typeof area === "string")
    && Boolean(supplier.minimumOrder && typeof supplier.minimumOrder.text === "string" && (supplier.minimumOrder.value === undefined || (typeof supplier.minimumOrder.value === "number" && Number.isFinite(supplier.minimumOrder.value))))
    && Boolean(supplier.price && typeof supplier.price.text === "string" && typeof supplier.price.available === "boolean")
    && Boolean(supplier.certificates && typeof supplier.certificates.text === "string" && ["confirmed", "partial", "unknown"].includes(supplier.certificates.status || ""))
    && Boolean(supplier.delivery && typeof supplier.delivery.text === "string" && (supplier.delivery.available === null || typeof supplier.delivery.available === "boolean"))
    && Boolean(supplier.contacts && isHttpUrl(supplier.contacts.website))
    && isStoredSource(supplier.source)
    && Array.isArray(supplier.sources)
    && supplier.sources.every(isStoredSource)
    && Boolean(supplier.factSources && typeof supplier.factSources === "object" && Object.values(supplier.factSources).every((source) => source === undefined || isStoredSource(source)))
    && typeof supplier.verifiedAt === "string"
    && supplier.origin === "live";
}

function sanitizeHistory(value: unknown): SearchHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_HISTORY_ENTRIES).flatMap((item): SearchHistoryEntry[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const saved = item as Partial<SearchHistoryEntry>;
    const criteria = sanitizeCriteria(saved.criteria);
    if (!criteria.query.trim() || !criteria.region || !Array.isArray(saved.suppliers)) return [];
    const suppliers = saved.suppliers.filter(isStoredSupplier).slice(0, 8);
    const result = saved.result;
    if (!result || result.provider !== "yandex" || typeof result.searchedAt !== "string") return [];
    return [{
      id: typeof saved.id === "string" ? saved.id.slice(0, 240) : `${result.searchedAt}:${criteria.query}`,
      criteria,
      suppliers,
      result: { provider: "yandex", model: typeof result.model === "string" ? result.model.slice(0, 120) : "yandexgpt-lite", searchedAt: result.searchedAt, cached: result.cached === true, count: suppliers.length },
    }];
  });
}

function historyKey(criteria: SearchCriteria): string {
  return JSON.stringify([
    criteria.query.trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " "),
    criteria.region,
    criteria.city.trim().toLocaleLowerCase("ru-RU"),
    criteria.quantity ?? "",
    criteria.quantityUnit,
    criteria.requiresCertificates,
    criteria.requiresDelivery,
    criteria.requiresPublishedPrice,
  ]);
}

function formatLocation(supplier: Supplier): string {
  const actualLocation = supplier.city && !/^не указано$/i.test(supplier.city) ? `${supplier.city} · ` : "";
  return `${actualLocation}поставляет в ${supplier.region}`;
}

export default function SupplierExplorer({ discoverEndpoint = "/api/discover" }: { discoverEndpoint?: string }) {
  const [criteria, setCriteria] = useState<SearchCriteria>(initialCriteria);
  const [appliedCriteria, setAppliedCriteria] = useState<SearchCriteria>(initialCriteria);
  const [sort, setSort] = useState<SortMode>("match");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [detailId, setDetailId] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<SearchHistoryEntry[]>([]);
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchError, setResearchError] = useState("");
  const [researchResult, setResearchResult] = useState<ResearchResult | null>(null);
  const [discoveredSuppliers, setDiscoveredSuppliers] = useState<Supplier[]>([]);
  const [copied, setCopied] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [accessStatus, setAccessStatus] = useState<AccessStatus>("checking");
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const resultsRef = useRef<HTMLElement>(null);

  /* eslint-disable react-hooks/set-state-in-effect -- browser state is restored after mount to avoid a server/client hydration mismatch. */
  useEffect(() => {
    try {
      const saved = localStorage.getItem("foodsup-user-state-v1");
      if (saved) {
        const parsed = JSON.parse(saved) as { notes?: Record<string, string>; criteria?: SearchCriteria; appliedCriteria?: SearchCriteria; history?: SearchHistoryEntry[] };
        if (parsed.notes && typeof parsed.notes === "object" && !Array.isArray(parsed.notes)) {
          setNotes(Object.fromEntries(Object.entries(parsed.notes).filter(([, note]) => typeof note === "string").slice(0, 100).map(([id, note]) => [id, note.slice(0, 4000)])));
        }
        if (parsed.criteria) {
          const restoredCriteria = sanitizeCriteria(parsed.criteria);
          setCriteria(restoredCriteria);
          setAppliedCriteria(parsed.appliedCriteria ? sanitizeCriteria(parsed.appliedCriteria) : restoredCriteria);
        }
        setHistory(sanitizeHistory(parsed.history));
      }
    } catch { /* invalid browser cache is ignored */ }
    setHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem("foodsup-user-state-v1", JSON.stringify({ notes, criteria, appliedCriteria, history }));
    } catch { /* private mode or a full storage quota must not break the product */ }
  }, [appliedCriteria, criteria, history, hydrated, notes]);

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    const savedCode = sessionStorage.getItem("foodsup-access-code")?.slice(0, 80) || "";
    void verifyRemoteAccess(discoverEndpoint, savedCode)
      .then(() => { if (active) { setAccessCode(savedCode); setAccessStatus("granted"); } })
      .catch(() => { if (active) { setAccessCode(""); setAccessStatus("required"); } });
    return () => { active = false; };
  }, [discoverEndpoint, hydrated]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setDetailId(null); setCompareOpen(false); setResearchOpen(false); setHistoryOpen(false); } };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  const ranked = useMemo(() => discoveredSuppliers.filter((supplier) => supplierMatches(supplier, appliedCriteria)).map((supplier) => ({ supplier, match: calculateMatch(supplier, appliedCriteria) })).sort((a, b) => {
    if (sort === "name") return a.supplier.name.localeCompare(b.supplier.name, "ru");
    if (sort === "complete") return b.match.completeness - a.match.completeness || compareRankedSuppliers(a, b);
    return compareRankedSuppliers(a, b);
  }), [appliedCriteria, discoveredSuppliers, sort]);

  const detail = detailId ? discoveredSuppliers.find((supplier) => supplier.id === detailId) ?? null : null;
  const compared = selectedIds.map((id) => discoveredSuppliers.find((supplier) => supplier.id === id)).filter(Boolean) as Supplier[];
  const canSearch = Boolean(criteria.region && criteria.query.trim());
  const updateCriteria = <K extends keyof SearchCriteria>(key: K, value: SearchCriteria[K]) => setCriteria((current) => ({ ...current, [key]: value }));
  const scrollToResults = () => requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  const showResearchResults = () => {
    setResearchOpen(false);
    requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const restoreHistory = (entry: SearchHistoryEntry) => {
    setCriteria(entry.criteria);
    setAppliedCriteria(entry.criteria);
    setDiscoveredSuppliers(entry.suppliers);
    setResearchResult(entry.result);
    setResearchError("");
    setSelectedIds([]);
    setDetailId(null);
    setCompareOpen(false);
    setResearchOpen(false);
    setHistoryOpen(false);
    scrollToResults();
  };

  const resetSearch = () => {
    setCriteria(initialCriteria);
    setAppliedCriteria(initialCriteria);
    setDiscoveredSuppliers([]);
    setResearchResult(null);
    setResearchError("");
    setSelectedIds([]);
    scrollToResults();
  };

  const toggleCompare = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length >= 4 ? current : [...current, id]);
  const useDemoQuery = () => {
    const demoCriteria: SearchCriteria = { query: "моцарелла", category: "Все категории", region: "Свердловская область", city: "Екатеринбург", quantityUnit: "кг", requiresCertificates: false, requiresDelivery: false, requiresPublishedPrice: false };
    setCriteria(demoCriteria);
  };

  const submitAccessCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!accessCode.trim()) { setAccessError("Введите код доступа."); return; }
    setAccessLoading(true); setAccessError("");
    try {
      await verifyRemoteAccess(discoverEndpoint, accessCode);
      sessionStorage.setItem("foodsup-access-code", accessCode.trim());
      setAccessStatus("granted");
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : "Не удалось проверить код доступа.");
    } finally {
      setAccessLoading(false);
    }
  };

  const closeAccess = () => {
    sessionStorage.removeItem("foodsup-access-code");
    setAccessCode(""); setAccessError(""); setAccessStatus("required");
  };

  const runResearch = async () => {
    if (!canSearch) return;
    const requestedCriteria: SearchCriteria = { ...criteria, category: "Все категории" };
    setAppliedCriteria(requestedCriteria);
    setDiscoveredSuppliers([]);
    setResearchOpen(true); setResearchLoading(true); setResearchError(""); setResearchResult(null);
    if (!discoverEndpoint) {
      setResearchError("Интернет-поиск ещё не подключён к публичной демоверсии. Проверьте URL серверной функции.");
      setResearchLoading(false);
      return;
    }
    try {
      const response = await fetch(discoverEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ criteria: requestedCriteria, accessCode: accessCode.trim() }) });
      const payload = await response.json() as { error?: string; suppliers?: Supplier[]; provider?: "yandex"; model?: string; searchedAt?: string; cached?: boolean };
      if (response.status === 401) {
        sessionStorage.removeItem("foodsup-access-code");
        setAccessCode(""); setAccessError("Код доступа изменён или больше не действует."); setAccessStatus("required"); setResearchOpen(false);
        return;
      }
      if (!response.ok) throw new Error(publicSearchError(payload.error || "Не удалось выполнить интернет-поиск"));
      const found = (payload.suppliers || []).filter(isStoredSupplier).slice(0, 8);
      setDiscoveredSuppliers(found);
      setSelectedIds([]);
      const result: ResearchResult = { provider: "yandex", model: payload.model || "yandexgpt-lite", searchedAt: payload.searchedAt || new Date().toISOString(), cached: payload.cached === true, count: found.length };
      setResearchResult(result);
      const entry: SearchHistoryEntry = { id: `${Date.now()}:${historyKey(requestedCriteria)}`, criteria: requestedCriteria, suppliers: found, result };
      setHistory((current) => [entry, ...current.filter((saved) => historyKey(saved.criteria) !== historyKey(requestedCriteria))].slice(0, MAX_HISTORY_ENTRIES));
    } catch (error) { setResearchError(error instanceof Error ? error.message : "Не удалось выполнить внешний поиск"); }
    finally { setResearchLoading(false); }
  };

  const copyMessage = async (supplier: Supplier) => {
    await navigator.clipboard.writeText(createOutreachMessage(supplier, appliedCriteria));
    setCopied(true); window.setTimeout(() => setCopied(false), 1800);
  };

  if (accessStatus !== "granted") {
    return <AccessGate status={accessStatus} code={accessCode} loading={accessLoading} error={accessError} onCode={setAccessCode} onSubmit={submitAccessCode} />;
  }

  return <main>
    <header className="topbar">
      <a className="brand" href="#top" aria-label="FoodSup — на главную"><span className="brand-mark">FS</span><span>FoodSup</span></a>
      <span className="region-pill">Вся Россия</span>
      <nav className="top-actions" aria-label="Основная навигация"><a href="#how">Как это работает</a><button className="button ghost small history-nav" type="button" onClick={() => setHistoryOpen(true)}>История{history.length ? <span>{history.length}</span> : null}</button><button className="button ghost small close-access" type="button" onClick={closeAccess}>Закрыть доступ</button></nav>
    </header>

    <section className="hero" id="top">
      <div className="hero-copy"><span className="eyebrow">Поиск поставщиков для HoReCa и производства</span><h1>Найдите поставщика.<br /><span>Сравните условия.</span></h1><p>Ищем поставщиков по конкретному субъекту России и собираем контакты, условия и источники в одном месте.</p></div>
      <div className="hero-note"><div><strong>89</strong><span>субъектов для поиска</span></div><div><strong>{categories.length}</strong><span>категорий определяются автоматически</span></div><div><strong>100%</strong><span>карточек с источником</span></div></div>
      <form className="search-panel" onSubmit={(event) => { event.preventDefault(); void runResearch(); }}>
        <label className="field field-query"><span>Что ищем</span><div className="input-wrap"><span aria-hidden="true">⌕</span><input value={criteria.query} onChange={(event) => updateCriteria("query", event.target.value)} placeholder="Например, моцарелла или упаковка для супа" /></div></label>
        <div className="field destination-field"><span>Куда поставлять</span><div className="destination-inputs"><select className={criteria.region ? undefined : "is-placeholder"} aria-label="Субъект РФ" value={criteria.region} onChange={(event) => updateCriteria("region", event.target.value)}><option value="" disabled>Например, Свердловская область</option>{russianRegions.map((region) => <option key={region}>{region}</option>)}</select><input aria-label="Город или населённый пункт" value={criteria.city} onChange={(event) => updateCriteria("city", event.target.value.slice(0, 80))} placeholder="Например, Екатеринбург (необязательно)" /></div></div>
        <div className="search-actions"><button className="button primary search-button" type="submit" disabled={!canSearch || researchLoading}><span>✦</span> {researchLoading ? "Идёт поиск…" : "Найти поставщиков"} <span className="beta">LLM</span></button></div>
      </form>
      <div className="hero-tools"><button className="demo-query" type="button" onClick={useDemoQuery}><span>Заполнить пример</span> Моцарелла · Екатеринбург</button></div>
    </section>

    <section className="how-section" id="how"><div><span>01</span><strong>Задайте требования</strong><p>Товар, регион и необходимые условия поставки.</p></div><div><span>02</span><strong>Проверьте факты</strong><p>Каждая карточка содержит источник и дату проверки.</p></div><div><span>03</span><strong>Сравните варианты</strong><p>До четырёх компаний в прозрачной таблице.</p></div></section>

    <section className="results-section" ref={resultsRef}>
      <div className="results-heading"><div><span className="eyebrow dark">Интернет-поиск с LLM</span><h2 aria-live="polite">{researchResult ? (ranked.length ? `Найдено поставщиков: ${ranked.length}` : "Поставщики не найдены") : "Запустите поиск поставщиков"}</h2><p>Итоговая оценка учитывает запрос, географию и подтверждённость условий; полнота показывает заполненность профиля.</p></div><div className="results-actions"><label className="sort-control"><span>Сортировка</span><select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="match">По итоговой оценке</option><option value="complete">По полноте</option><option value="name">По названию</option></select></label></div></div>
      <div className="results-layout">
        <aside className="filters-card"><div className="filter-title"><strong>Уточнить поиск</strong><button type="button" onClick={resetSearch}>Сбросить</button></div><label className="filter-group"><span>Субъект РФ</span><select className={criteria.region ? undefined : "is-placeholder"} value={criteria.region} onChange={(event) => updateCriteria("region", event.target.value)}><option value="" disabled>Например, Свердловская область</option>{russianRegions.map((region) => <option key={region}>{region}</option>)}</select></label><label className="filter-group"><span>Город / населённый пункт</span><input value={criteria.city} maxLength={80} onChange={(event) => updateCriteria("city", event.target.value)} placeholder="Например, Екатеринбург (необязательно)" /></label><label className="filter-group quantity-filter"><span>Потребность — необязательно</span><div className={criteria.quantity ? "quantity-inputs" : "quantity-inputs single"}><input min="1" max="1000000" type="number" value={criteria.quantity ?? ""} onChange={(event) => { const value = Number(event.target.value); updateCriteria("quantity", Number.isFinite(value) && value > 0 ? Math.min(value, 1_000_000) : undefined); }} placeholder="Например, 50" />{criteria.quantity && <select aria-label="Единица потребности" value={criteria.quantityUnit} onChange={(event) => updateCriteria("quantityUnit", event.target.value as SearchCriteria["quantityUnit"])}>{quantityUnits.map((unit) => <option key={unit} value={unit}>{unit === "шт" ? "шт." : unit === "упак" ? "упак." : unit}</option>)}</select>}</div><small className="filter-hint">Используется только для сравнения с минимальным заказом.</small></label><div className="filter-group switches"><span>Обязательные условия</span><Switch label="Есть доставка" checked={criteria.requiresDelivery} onChange={(value) => updateCriteria("requiresDelivery", value)} /><Switch label="Указаны документы" checked={criteria.requiresCertificates} onChange={(value) => updateCriteria("requiresCertificates", value)} /><Switch label="Цена опубликована" checked={criteria.requiresPublishedPrice} onChange={(value) => updateCriteria("requiresPublishedPrice", value)} /></div><button className="button primary filter-apply" type="button" onClick={() => void runResearch()} disabled={!canSearch || researchLoading}>{researchLoading ? "Идёт поиск…" : "Найти с этими условиями"}</button><div className="source-promise"><span>✓</span><p><strong>Без вымышленных данных</strong>Неизвестные условия превращены в вопросы поставщику.</p></div></aside>
        <div className="supplier-list">
          {!ranked.length ? <div className="empty-state"><span>⌕</span><h3>{researchResult ? "Поставщиков по таким условиям не найдено" : !criteria.region ? "Выберите субъект РФ" : !criteria.query.trim() ? "Укажите товар" : "Запустите поиск"}</h3><p>{researchResult ? "Уточните товар, город или обязательные условия и повторите поиск." : "Карточки появятся здесь после интернет-поиска."}</p><div><button className="button secondary" type="button" onClick={resetSearch}>Сбросить параметры</button></div></div> : ranked.map(({ supplier, match }, index) => <SupplierCard key={supplier.id} supplier={supplier} criteria={appliedCriteria} match={match} recommendation={sort === "match" && index === 0 ? recommendationKind(supplier, match) : undefined} selected={selectedIds.includes(supplier.id)} compareFull={selectedIds.length >= 4} onCompare={() => toggleCompare(supplier.id)} onDetails={() => setDetailId(supplier.id)} />)}
        </div>
      </div>
    </section>

    <footer className="site-footer"><div className="brand"><span className="brand-mark">FS</span><span>FoodSup</span></div><p>Демонстрационный сервис · Данные из открытых источников · Не является офертой</p><a href="#top">Наверх ↑</a></footer>

    {!!selectedIds.length && <div className="compare-bar"><div><strong>Сравнение</strong><span>{selectedIds.length} из 4 выбрано</span></div><div className="compare-avatars">{compared.map((supplier) => <button key={supplier.id} type="button" title={`Убрать ${supplier.name}`} onClick={() => toggleCompare(supplier.id)}>{supplier.name.slice(0, 2).toLocaleUpperCase("ru-RU")}<i>×</i></button>)}</div><button className="button primary" type="button" disabled={selectedIds.length < 2} onClick={() => setCompareOpen(true)}>Сравнить поставщиков →</button></div>}

    {detail && <DetailModal supplier={detail} criteria={appliedCriteria} note={notes[detail.id] || ""} copied={copied} onNote={(value) => setNotes((current) => ({ ...current, [detail.id]: value.slice(0, 4000) }))} onCopy={() => copyMessage(detail)} onClose={() => setDetailId(null)} />}
    {compareOpen && <CompareModal suppliers={compared} criteria={appliedCriteria} onClose={() => setCompareOpen(false)} />}
    {researchOpen && <ResearchModal loading={researchLoading} error={researchError} result={researchResult} showSetupHint={Boolean(discoverEndpoint)} onShowResults={showResearchResults} onClose={() => setResearchOpen(false)} />}
    {historyOpen && <HistoryModal entries={history} onRestore={restoreHistory} onClear={() => setHistory([])} onClose={() => setHistoryOpen(false)} />}
  </main>;
}

function AccessGate({ status, code, loading, error, onCode, onSubmit }: { status: AccessStatus; code: string; loading: boolean; error: string; onCode: (value: string) => void; onSubmit: (event: React.FormEvent) => void }) {
  return <main className="access-page"><section className="access-card" aria-labelledby="access-title"><div className="access-brand"><span className="brand-mark">FS</span><strong>FoodSup</strong></div><span className="eyebrow dark">Закрытая демоверсия</span><h1 id="access-title">Поиск поставщиков<br />для закупок</h1><p>Введите код, выданный для проверки сервиса. После входа будут доступны поиск по открытым источникам, карточки и сравнение поставщиков.</p>{status === "checking" ? <div className="access-checking" role="status"><span>✦</span> Проверяем доступ…</div> : <form onSubmit={onSubmit}><label htmlFor="access-code">Код доступа</label><input id="access-code" type="password" value={code} onChange={(event) => onCode(event.target.value.slice(0, 80))} autoComplete="current-password" autoFocus aria-describedby={error ? "access-error" : undefined} /><button className="button primary" type="submit" disabled={loading}>{loading ? "Проверяем…" : "Открыть сервис →"}</button>{error && <p className="access-error" id="access-error" role="alert">{error}</p>}</form>}<small>Код не передаётся сторонним сервисам и хранится только до закрытия вкладки.</small></section><aside className="access-aside"><span>Что внутри</span><ol><li><strong>Интернет-поиск с LLM</strong><p>Поставщики находятся по товару и субъекту России.</p></li><li><strong>Карточки с источниками</strong><p>Неизвестные условия не выдумываются.</p></li><li><strong>Прозрачное сравнение</strong><p>Итоговая оценка объясняется по критериям.</p></li></ol></aside></main>;
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /><span>{label}</span></label>;
}

type RecommendationKind = "confirmed" | "candidate";

function recommendationKind(supplier: Supplier, match: ReturnType<typeof calculateMatch>): RecommendationKind | undefined {
  if (match.score < 60) return undefined;
  return match.completeness >= 70 && commercialEvidenceCount(supplier) >= 2 ? "confirmed" : "candidate";
}

function SupplierCard({ supplier, criteria, match, recommendation, selected, compareFull, onCompare, onDetails }: { supplier: Supplier; criteria: SearchCriteria; match: ReturnType<typeof calculateMatch>; recommendation?: RecommendationKind; selected: boolean; compareFull: boolean; onCompare: () => void; onDetails: () => void }) {
  const checklist = getManagerChecklist(supplier, criteria);
  return <article className="supplier-card live"><div className="supplier-main"><div className="supplier-title-row"><div className="supplier-avatar">{supplier.name.slice(0, 2).toLocaleUpperCase("ru-RU")}</div><div><div className="supplier-badges">{recommendation === "confirmed" && <span className="recommended">★ Лучшее подтверждённое</span>}{recommendation === "candidate" && <span className="candidate-badge">Наиболее релевантный кандидат</span>}<span className="live-badge">Найдено в интернете</span>{supplier.categories.map((category) => <span key={category}>{category}</span>)}</div><h3>{supplier.name}</h3><p className="location">● {formatLocation(supplier)}</p>{(supplier.contacts.phone || supplier.contacts.email) && <p className="supplier-contacts">{supplier.contacts.phone && <a href={`tel:${supplier.contacts.phone.replace(/[^\d+]/g, "")}`}>☎ {supplier.contacts.phone}</a>}{supplier.contacts.email && <a href={`mailto:${supplier.contacts.email}`}>✉ {supplier.contacts.email}</a>}</p>}</div><div className="score-wrap"><div className="score" style={{ "--score": `${match.score * 3.6}deg` } as React.CSSProperties}><strong>{match.score}%</strong><span>оценка</span></div><small>Данные {match.completeness}%</small></div></div><p className="supplier-description">{supplier.description}</p><div className="product-tags">{supplier.products.slice(0, 5).map((product) => <span key={product}>{product}</span>)}</div><div className="facts-grid"><Fact title="Мин. заказ" text={supplier.minimumOrder.text} source={supplier.factSources?.minimumOrder} /><Fact title="Цена" text={supplier.price.text} positive={supplier.price.available} source={supplier.factSources?.price} /><Fact title="Документы" text={supplier.certificates.text} positive={supplier.certificates.status === "confirmed"} source={supplier.factSources?.certificates} /><Fact title="Доставка" text={supplier.delivery.text} positive={supplier.delivery.available === true} source={supplier.factSources?.delivery} /></div><div className="match-explanation"><div>{match.reasons.slice(0, 2).map((reason) => <span key={reason}>✓ {reason}</span>)}</div>{match.warnings[0] && <span className="warning">! {match.warnings[0]}</span>}</div><details className="manager-checklist"><summary>Что уточнить менеджеру <span>{checklist.missingFacts.length}</span></summary><div className="checklist-popover" role="note"><strong>{checklist.missingFacts.length ? "Не найдено в источниках" : "Основные факты найдены"}</strong>{checklist.missingFacts.length ? <ul>{checklist.missingFacts.map((item) => <li key={item.id}><b>{item.title}:</b> {item.question}</li>)}</ul> : <p>Перед заказом всё равно подтвердите актуальность условий.</p>}<strong>Перед контактом</strong><ul>{checklist.standardChecks.map((item) => <li key={item.id}>{item.question}</li>)}</ul></div></details></div><footer className="supplier-footer"><div className="verified"><span>Найдено {supplier.verifiedAt}</span><a href={supplier.source.url} target="_blank" rel="noreferrer">Основной источник ↗</a>{(supplier.sources?.length || 0) > 1 && <span>Источников: {supplier.sources.length}</span>}</div><div><button className={selected ? "button compare selected" : "button compare"} type="button" onClick={onCompare} disabled={!selected && compareFull}>{selected ? "✓ В сравнении" : "+ Сравнить"}</button><button className="button secondary" type="button" onClick={onDetails}>Подробнее →</button></div></footer></article>;
}

function Fact({ title, text, positive = false, source }: { title: string; text: string; positive?: boolean; source?: SupplierSource }) { return <div><span>{title}</span><strong className={positive ? "positive" : "muted"}>{text}</strong>{source && <a className="fact-source" href={source.url} target="_blank" rel="noreferrer">Источник ↗</a>}</div>; }

function DetailModal({ supplier, criteria, note, copied, onNote, onCopy, onClose }: { supplier: Supplier; criteria: SearchCriteria; note: string; copied: boolean; onNote: (value: string) => void; onCopy: () => void; onClose: () => void }) {
  const match = calculateMatch(supplier, criteria);
  return <Modal labelledBy="detail-title" onClose={onClose}><div className="detail-head"><div className="supplier-avatar large">{supplier.name.slice(0, 2).toLocaleUpperCase("ru-RU")}</div><div><span className="eyebrow dark">Профиль поставщика</span><h2 id="detail-title">{supplier.name}</h2><p>● {formatLocation(supplier)}</p></div></div><p className="detail-description">{supplier.description}</p><div className="detail-score"><div className="detail-metrics"><div><strong>{match.score}%</strong><span>Итоговая оценка</span></div><div><strong>{match.completeness}%</strong><span>Полнота данных</span></div></div><div className="score-breakdown"><b>Как рассчитана итоговая оценка</b>{match.breakdown.map((item) => <div key={item.key}><span>{item.label}<small>{item.note}</small></span><strong>{Math.round(item.earned)}/{item.max}</strong></div>)}</div></div><div className="detail-sections"><div><h3>Условия</h3><dl><DetailFact label="Минимальный заказ" text={supplier.minimumOrder.text} source={supplier.factSources?.minimumOrder} /><DetailFact label="Цена" text={supplier.price.text} source={supplier.factSources?.price} /><DetailFact label="Доставка" text={supplier.delivery.text} source={supplier.factSources?.delivery} /><DetailFact label="Документы" text={supplier.certificates.text} source={supplier.factSources?.certificates} /></dl></div><div><h3>Контакты</h3><div className="contact-list">{supplier.contacts.phone && <a href={`tel:${supplier.contacts.phone}`}>{supplier.contacts.phone}</a>}{supplier.contacts.email && <a href={`mailto:${supplier.contacts.email}`}>{supplier.contacts.email}</a>}<a href={supplier.contacts.website} target="_blank" rel="noreferrer">Открыть сайт ↗</a></div><div className="source-line"><strong>Проверенные источники</strong>{(supplier.sources?.length ? supplier.sources : [supplier.source]).map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a>)}<span>Проверено {supplier.verifiedAt}</span></div></div></div><label className="notes-field"><span>Моя заметка <small>сохраняется только в браузере</small></span><textarea maxLength={4000} value={note} onChange={(event) => onNote(event.target.value)} placeholder="Например: запросить образцы и прайс до пятницы" /></label><div className="outreach-box"><div><span>✦</span><p><strong>Подготовить первое обращение</strong>Неизвестные условия будут включены в вопросы.</p></div><button className="button primary" type="button" onClick={onCopy}>{copied ? "✓ Скопировано" : "Скопировать текст"}</button></div></Modal>;
}

function DetailFact({ label, text, source }: { label: string; text: string; source?: SupplierSource }) {
  return <div><dt>{label}</dt><dd>{text}{source && <a className="detail-fact-source" href={source.url} target="_blank" rel="noreferrer">Источник ↗</a>}</dd></div>;
}

function CompareModal({ suppliers, criteria, onClose }: { suppliers: Supplier[]; criteria: SearchCriteria; onClose: () => void }) {
  const best = suppliers.map((supplier) => ({ supplier, match: calculateMatch(supplier, criteria) })).sort(compareRankedSuppliers)[0]?.supplier;
  return <Modal labelledBy="compare-title" wide onClose={onClose}><span className="eyebrow dark">Короткий список</span><h2 id="compare-title">Сравнение поставщиков</h2><p className="modal-lead">Сильные стороны подсвечены только на основании открытых данных.</p><div className="compare-table-wrap"><table className="compare-table"><thead><tr><th>Критерий</th>{suppliers.map((supplier) => <th key={supplier.id}>{supplier.name}<small>{formatLocation(supplier)}</small></th>)}</tr></thead><tbody><CompareRow title="Итоговая оценка" suppliers={suppliers} render={(supplier) => <strong className="table-score">{calculateMatch(supplier, criteria).score}%</strong>} /><CompareRow title="Полнота данных" suppliers={suppliers} render={(supplier) => <strong>{calculateMatch(supplier, criteria).completeness}%</strong>} /><CompareRow title="Мин. заказ" suppliers={suppliers} render={(supplier) => supplier.minimumOrder.text} /><CompareRow title="Цена" suppliers={suppliers} good={(supplier) => supplier.price.available} render={(supplier) => supplier.price.text} /><CompareRow title="Документы" suppliers={suppliers} good={(supplier) => supplier.certificates.status === "confirmed"} render={(supplier) => supplier.certificates.text} /><CompareRow title="Доставка" suppliers={suppliers} good={(supplier) => supplier.delivery.available === true} render={(supplier) => supplier.delivery.text} /><CompareRow title="Контакт" suppliers={suppliers} render={(supplier) => <div className="contact-cell">{supplier.contacts.phone && <a href={`tel:${supplier.contacts.phone.replace(/[^\d+]/g, "")}`}>☎ {supplier.contacts.phone}</a>}{supplier.contacts.email && <a href={`mailto:${supplier.contacts.email}`}>✉ {supplier.contacts.email}</a>}<a href={supplier.contacts.website} target="_blank" rel="noreferrer">Сайт ↗</a></div>} /></tbody></table></div><div className="compare-recommendation"><span>Приоритет для проверки</span><p><strong>{best?.name} получил лучшую итоговую оценку среди выбранных.</strong> Это не оценка надёжности: перед заказом подтвердите цену, наличие, документы и условия поставки.</p></div></Modal>;
}

function CompareRow({ title, suppliers, render, good }: { title: string; suppliers: Supplier[]; render: (supplier: Supplier) => React.ReactNode; good?: (supplier: Supplier) => boolean }) { return <tr><td>{title}</td>{suppliers.map((supplier) => <td className={good?.(supplier) ? "cell-good" : ""} key={supplier.id}>{render(supplier)}</td>)}</tr>; }

function ResearchModal({ loading, error, result, showSetupHint, onShowResults, onClose }: { loading: boolean; error: string; result: ResearchResult | null; showSetupHint: boolean; onShowResults: () => void; onClose: () => void }) {
  return <Modal labelledBy="research-title" onClose={onClose}><span className="eyebrow dark">Интернет-поиск · LLM · beta</span><h2 id="research-title">Поиск поставщиков</h2>{loading && <div className="research-loading"><span>✦</span><strong>Ищу поставщиков и проверяю источники…</strong><p>Обычно это занимает до 50 секунд.</p></div>}{error && <div className="research-error"><strong>Поиск сейчас недоступен</strong><p>{error}</p>{showSetupHint && <p>Проверьте настройки серверной функции и повторите запрос.</p>}</div>}{result && <div className="research-result"><p className="ai-disclaimer">Найденные в интернете данные требуют ручной проверки перед контактом.</p><div className="research-summary"><strong>{result.count ? `Найдено карточек: ${result.count}` : "Поставщиков не найдено"}</strong><span>{result.cached ? "Ответ из кэша" : "Выполнен новый интернет-поиск"}</span><span>{new Date(result.searchedAt).toLocaleString("ru-RU")}</span></div><button className="button primary" type="button" onClick={onShowResults}>{result.count ? "Перейти к найденным карточкам" : "Вернуться к результатам"}</button></div>}</Modal>;
}

function HistoryModal({ entries, onRestore, onClear, onClose }: { entries: SearchHistoryEntry[]; onRestore: (entry: SearchHistoryEntry) => void; onClear: () => void; onClose: () => void }) {
  return <Modal labelledBy="history-title" onClose={onClose}><span className="eyebrow dark">Сохранено в этом браузере</span><h2 id="history-title">История запросов</h2><p className="modal-lead">Можно вернуться к прежним карточкам без повторного интернет-поиска. Хранятся восемь последних разных запросов.</p>{entries.length ? <><div className="history-list">{entries.map((entry) => <article className="history-item" key={entry.id}><div><strong>{entry.criteria.query}</strong><span>{entry.criteria.city ? `${entry.criteria.city} · ` : ""}{entry.criteria.region}</span><small>{new Date(entry.result.searchedAt).toLocaleString("ru-RU")} · {entry.result.count ? `карточек: ${entry.result.count}` : "ничего не найдено"}{entry.result.cached ? " · ответ из кэша" : ""}</small></div><button className="button secondary" type="button" onClick={() => onRestore(entry)}>Открыть результаты</button></article>)}</div><button className="history-clear" type="button" onClick={onClear}>Очистить историю</button></> : <div className="history-empty"><span>⌕</span><strong>История пока пуста</strong><p>Первый успешно завершённый поиск появится здесь.</p></div>}</Modal>;
}

function Modal({ children, labelledBy, onClose, wide = false }: { children: React.ReactNode; labelledBy: string; onClose: () => void; wide?: boolean }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={wide ? "modal compare-modal" : "modal"} role="dialog" aria-modal="true" aria-labelledby={labelledBy}><button className="modal-close" type="button" aria-label="Закрыть" onClick={onClose} autoFocus>×</button>{children}</section></div>;
}
