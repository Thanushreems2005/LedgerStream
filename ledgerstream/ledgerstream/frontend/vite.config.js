import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API runs on :3001 (see ../api/server.js). During dev we proxy /api
// requests to it, so the frontend never needs to know the API origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});