import type { Metadata } from "next";
import SupplierExplorer from "./components/SupplierExplorer";

export const metadata: Metadata = {
  title: "FoodSup — поиск поставщиков продуктов",
  description: "Поиск и сравнение поставщиков продуктов питания и упаковки по субъектам России.",
};

export default function Home() { return <SupplierExplorer />; }
