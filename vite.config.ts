/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 loopback explicitly; the default 'localhost' can resolve to
    // ::1 first, which Tailscale serve's IPv4 proxy target can't reach.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Vite rejects any request whose Host header isn't localhost, so the
    // tailnet URL would otherwise serve "Blocked request. This host is not
    // allowed." The leading dot covers ts.net and every subdomain. Don't
    // replace this with `true` — that disables the DNS-rebinding protection
    // the setting exists for.
    allowedHosts: ['.ts.net'],
    // The page arrives over HTTPS on 443 via Tailscale serve; without this
    // Vite tells the browser to open its HMR websocket on 5173 and it hangs.
    hmr: { protocol: 'wss', clientPort: 443 },
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
    // The server tests run under node, not jsdom. They always should have —
    // nothing under server/ touches a DOM — but it became load-bearing when
    // the stores moved onto SQLite: jsdom's module resolution rewrites
    // `node:sqlite` to a bare `sqlite`, looks for an npm package of that name
    // and fails the whole suite at import with "Failed to load url sqlite".
    // node resolves the builtin directly.
    environmentMatchGlobs: [['server/**', 'node']],
  },
});
