// What node code gets from the host, not bundled: one React and one bridge for every node (core compile.ts compiles
// `import … from "react"` / "pagent" to a read of globalThis.__PAGENT__.modules). The shell provides them.
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import * as bridge from "@pagent/bridge";

export function provideHostModules() {
  (globalThis as any).__PAGENT__ = {
    modules: {
      react: React,
      "react-dom": ReactDOM,
      "react-dom/client": ReactDOMClient,
      "react/jsx-runtime": jsxRuntime,
      "react/jsx-dev-runtime": jsxRuntime,
      pagent: bridge,
    },
  };
}
