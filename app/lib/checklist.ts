import type { SearchCriteria, Supplier } from "../types";

export interface ManagerChecklistItem {
  id: string;
  title: string;
  question: string;
}

export interface ManagerChecklist {
  missingFacts: ManagerChecklistItem[];
  standardChecks: ManagerChecklistItem[];
}

export function getManagerChecklist(supplier: Supplier, criteria: SearchCriteria): ManagerChecklist {
  const destination = criteria.city.trim()
    ? `${criteria.city}, ${criteria.region}`
    : criteria.region;
  const missingFacts: ManagerChecklistItem[] = [];

  if (!supplier.price.available) {
    missingFacts.push({ id: "price", title: "Цена и НДС", question: "Запросить актуальную цену, единицу расчёта и наличие НДС." });
  }
  if (!supplier.minimumOrder.value) {
    missingFacts.push({ id: "minimum-order", title: "Минимальный заказ", question: "Уточнить минимальный объём заказа, партию и кратность." });
  }
  if (supplier.delivery.available !== true) {
    missingFacts.push({ id: "delivery", title: "Доставка", question: `Уточнить стоимость, график и возможность доставки в ${destination}.` });
  }
  if (supplier.certificates.status !== "confirmed") {
    missingFacts.push({ id: "documents", title: "Документы", question: "Запросить сертификаты, декларации и сопроводительные документы на товар." });
  }
  if (!supplier.contacts.phone && !supplier.contacts.email) {
    missingFacts.push({ id: "contact", title: "Прямой контакт", question: "Найти телефон или email отдела оптовых продаж." });
  }

  const standardChecks: ManagerChecklistItem[] = [
    { id: "availability", title: "Наличие и срок", question: "Подтвердить доступный объём и ближайшую дату отгрузки." },
    { id: "payment", title: "Оплата", question: "Уточнить условия оплаты, отсрочку и порядок возврата." },
    { id: "quality", title: "Качество партии", question: "Согласовать упаковку, срок годности и условия хранения или перевозки." },
  ];

  return { missingFacts, standardChecks };
}
