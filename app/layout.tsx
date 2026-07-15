import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") || headerStore.get("host") || "localhost:5173";
  const protocol = headerStore.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;
  return {
    title: "FoodSup — поиск поставщиков продуктов",
    description: "Сравнивайте условия, источники и контакты поставщиков по субъектам России.",
    openGraph: { title: "FoodSup — поиск поставщиков продуктов", description: "Найдите поставщика. Сравните условия.", locale: "ru_RU", type: "website", images: [{ url: imageUrl, width: 1536, height: 1024, alt: "FoodSup — найдите поставщика и сравните условия" }] },
    twitter: { card: "summary_large_image", title: "FoodSup — поиск поставщиков продуктов", description: "Найдите поставщика. Сравните условия.", images: [imageUrl] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
