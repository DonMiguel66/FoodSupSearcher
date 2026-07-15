import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import SupplierExplorer from "../app/components/SupplierExplorer";
import "../app/globals.css";

const root = document.getElementById("root");

if (!root) throw new Error("Не найден корневой элемент приложения");

createRoot(root).render(
  <StrictMode>
    <SupplierExplorer discoverEndpoint={import.meta.env.VITE_DISCOVER_API_URL || ""} />
  </StrictMode>,
);
