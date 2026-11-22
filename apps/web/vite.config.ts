import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",                       // "A new version is ready" → Reload
      includeAssets: ["favicon.ico", "apple-touch-icon-180.png"],
      manifest: {
        name: "Haven",
        short_name: "Haven",
        display: "standalone",
        orientation: "portrait",
        background_color: "#FBFAF6",
        theme_color: "#FBFAF6",
        start_url: "/",
        icons: [
          { src: "/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
          { src: "/haven-glyph-monochrome.svg", sizes: "any", type: "image/svg+xml", purpose: "monochrome" },
        ],
      },
      // The Google OAuth callback lands on "/" with ?code= — it must bypass the
      // service worker: Safari refuses service-worker-served responses that went
      // through the Worker's 302 redirect to /login/callback.
      workbox: { navigateFallbackDenylist: [/^\/api\//, /^\/auth\//, /[?&]code=/], globPatterns: ["**/*.{js,css,html,woff2,png,svg,ico}"] },
    }),
  ],
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.1.0") },
  server: { proxy: { "/api": "http://localhost:8787", "/auth": "http://localhost:8787" } },
});
