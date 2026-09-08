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
    // HMR is deliberately NOT pinned to a protocol or a port.
    //
    // It used to be `{ protocol: 'wss', clientPort: 443 }` for the Tailscale
    // URL, and that broke both halves of the setup. Left to itself the client
    // derives both from the URL the page was actually served on — wss on 443
    // through Tailscale serve, ws on 5173 straight off 127.0.0.1 — so one
    // setting cannot be right for both, and pinning it made the local tab the
    // one that was wrong: its socket could never open, so no edit ever reached
    // it, and Vite's reconnect path then polls https://<host>/ and reloads the
    // page the instant that answers. On this machine something is always
    // answering on 443 (Tailscale serve), so a tab on 127.0.0.1:5173 would
    // reload itself out of the blue, mid-edit. Unpinned, both URLs connect,
    // and neither reloads on its own.
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
