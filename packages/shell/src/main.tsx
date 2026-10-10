import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import * as bridge from "@pagent/bridge";
import { App } from "./App.tsx";
import { startScreenRelay } from "./screen.ts";
import "./styles.css";

// Node modules are compiled with these as host-provided singletons (one React, one bridge).
(globalThis as any).__HA__ = {
  modules: {
    react: React,
    "react-dom": ReactDOM,
    "react-dom/client": ReactDOMClient,
    "react/jsx-runtime": jsxRuntime,
    "react/jsx-dev-runtime": jsxRuntime,
    pagent: bridge,
  },
};

ReactDOMClient.createRoot(document.getElementById("root")!).render(<App />);
startScreenRelay();
