import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Tauri prefers a fixed dev port; failure to use it disables HMR over IPC.
const TAURI_DEV_PORT = 1420;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    // pnpm + `link:` protocol leaves each repo with its own `react` /
    // `react-dom` resolution. Vite would otherwise bundle two React
    // instances (one per consuming graph), and React 19 panics with
    // `S.H.useCallback is null` when the dispatcher is set on the
    // other copy. Force one.
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  clearScreen: false,
  server: {
    port: TAURI_DEV_PORT,
    strictPort: true,
    host: '0.0.0.0',
  },
  build: {
    target: 'es2024',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        splash: fileURLToPath(new URL('./splash.html', import.meta.url)),
      },
    },
  },
});
