import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// README screenshots and GIFs are made from the browser preview (`npm run dev`,
// then /?shot — see scripts/media.mjs): draw the macOS window buttons there.
if (!("__TAURI_INTERNALS__" in window) && new URLSearchParams(location.search).has("shot")) {
  document.documentElement.classList.add("shot");
}

// No <StrictMode>: its double-invoked effects would start every scan twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
