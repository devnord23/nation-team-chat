import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./AdminApp";
import { applySkin, readSkin } from "../lib/skins";
import "../styles.css";

applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StrictMode><AdminApp /></StrictMode>);
