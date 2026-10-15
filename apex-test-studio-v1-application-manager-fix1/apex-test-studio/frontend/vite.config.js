import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, forward API + video requests to the Python backend (python server.py on :8000)
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8000", "/media": "http://localhost:8000" } },
});
