import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SupplierExplorer from "../app/components/SupplierExplorer";
import { GET } from "../app/api/health/route";

test("server-renders the access gate before the search interface", () => {
  const html = renderToStaticMarkup(createElement(SupplierExplorer, { discoverEndpoint: "" }));
  assert.match(html, /FoodSup/);
  assert.match(html, /Закрытая демоверсия/);
  assert.match(html, /Проверяем доступ/);
  assert.doesNotMatch(html, /Найти поставщиков|Результаты Yandex/);
});

test("health endpoint reports the live-search-only data mode", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  const payload = await response.json() as { status: string; dataMode: string; liveSearchProvider: string; liveSearchAvailable: boolean };
  assert.equal(payload.status, "ok");
  assert.equal(payload.dataMode, "live-search-only");
  assert.equal(payload.liveSearchProvider, "yandex");
  assert.equal(typeof payload.liveSearchAvailable, "boolean");
});
