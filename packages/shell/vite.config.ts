import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = `http://127.0.0.1:${process.env.PAGENT_PORT ?? 4870}`;

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    port: Number(process.env.SHELL_PORT ?? 5173),
    proxy: { "/_pagent": { target: server, ws: true }, "/api": server, "/mcp": server },
  },
});
