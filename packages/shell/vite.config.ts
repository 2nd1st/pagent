import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = `http://127.0.0.1:${process.env.PAGENT_PORT ?? 4870}`;

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    port: Number(process.env.SHELL_PORT ?? 5173),
    // /_pagent keeps the browser's Host (no changeOrigin, which vite sets for a plain string target): the server takes
    // a page on its own plane only when the page's origin is the address it was reached at (server.ts, originOk),
    // through here this dev server's. With changeOrigin, every request of the shell would be refused.
    proxy: { "/_pagent": { target: server, ws: true }, "/api": server, "/mcp": server },
    // Only the app's own pages may frame it, as the server says for the built shell (server.ts, FRAMING).
    headers: { "content-security-policy": "frame-ancestors 'self'", "x-frame-options": "SAMEORIGIN" },
  },
});
