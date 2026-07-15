import type { categories } from "./data/categories";

export type Category = typeof categories[number];
export type FactStatus = "confirmed" | "partial" | "unknown";
export type SupplierFactKey = "minimumOrder" | "price" | "certificates" | "delivery" | "contacts";

export interface SupplierSource {
  url: string;
  title: string;
  publisher: string;
  checkedAt: string;
  confidence: "high" | "medium" | "low";
}

export interface Supplier {
  id: string;
  name: string;
  region: string;
  city: string;
  description: string;
  categories: Category[];
  products: string[];
  serviceAreas: string[];
  minimumOrder: { value?: number; unit?: "кг" | "л" | "шт" | "упак" | "₽"; text: string };
  price: { available: boolean; text: string };
  certificates: { status: FactStatus; text: string };
  delivery: { available: boolean | null; text: string };
  contacts: { website: string; phone?: string; email?: string };
  source: SupplierSource;
  sources: SupplierSource[];
  factSources: Partial<Record<SupplierFactKey, SupplierSource>>;
  verifiedAt: string;
  origin: "live";
}

export interface SearchCriteria {
  query: string;
  category: Category | "Все категории";
  region: string;
  city: string;
  quantity?: number;
  quantityUnit: "кг" | "л" | "шт" | "упак";
  requiresCertificates: boolean;
  requiresDelivery: boolean;
  requiresPublishedPrice: boolean;
}

export interface MatchResult {
  score: number;
  completeness: number;
  breakdown: MatchBreakdownItem[];
  reasons: string[];
  warnings: string[];
}

export type MatchCriterionKey = "product" | "geography" | "minimumOrder" | "certificates" | "delivery" | "price" | "data";

export interface MatchBreakdownItem {
  key: MatchCriterionKey;
  label: string;
  earned: number;
  max: number;
  note: string;
}
