import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend builds to app/web/dist, which the Express server serves as
// static files in production. In development, `npm run dev` runs Vite's dev
// server and proxies /api to the Express backend on :3000, so there is still
// only one backend to run.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
