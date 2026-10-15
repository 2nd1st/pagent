import * as ReactDOMClient from "react-dom/client";
import { App } from "./App.tsx";
import { provideHostModules } from "./host-modules.ts";
import { startScreenRelay } from "./screen.ts";
import "./styles.css";

// Node modules are compiled with these as host-provided singletons (one React, one bridge).
provideHostModules();

// The page's language is the reader's (fonts, line breaking, quotes): pages are written in the language people write in.
document.documentElement.lang = navigator.language || "en";

ReactDOMClient.createRoot(document.getElementById("root")!).render(<App />);
startScreenRelay();
