import assert from "node:assert/strict";
import test from "node:test";
import { categories } from "../app/data/categories";
import { russianRegions } from "../app/data/regions";
import { criteriaSchema } from "../app/lib/discovery";

test("search dictionaries contain unique supported values", () => {
  for (const baseline of ["Молочная продукция", "Мясо", "Овощи", "Упаковка", "Напитки"] as const) {
    assert.ok(categories.includes(baseline), `missing baseline category: ${baseline}`);
  }
  assert.equal(new Set(categories).size, categories.length);
  assert.ok(categories.every((category) => category.trim().length > 0));

  assert.equal(russianRegions.length, 89);
  assert.equal(new Set(russianRegions).size, russianRegions.length);
  assert.ok(russianRegions.every((region) => region.trim().length > 0));
});

test("accepts package demand but not a monetary value as a quantity unit", () => {
  const baseline = { query: "чай", category: "Все категории", region: "Ивановская область", city: "", quantity: 10, requiresCertificates: false, requiresDelivery: false, requiresPublishedPrice: false };
  assert.equal(criteriaSchema.safeParse({ ...baseline, quantityUnit: "упак" }).success, true);
  assert.equal(criteriaSchema.safeParse({ ...baseline, quantityUnit: "₽" }).success, false);
});
