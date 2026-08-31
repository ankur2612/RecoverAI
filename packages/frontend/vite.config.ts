import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The browser never holds a provider secret and never calls Razorpay or
    // Gemini. Every privileged operation goes through the backend, which is
    // proxied here so development uses one origin.
    proxy: {
      '/api': {
        target: process.env.RECOVERAI_API_URL ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
