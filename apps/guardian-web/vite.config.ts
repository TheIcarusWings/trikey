import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5174,
      // With VITE_API=http the dev server forwards /api to a running guardian.
      proxy: {
        '/api': {
          target: env.GUARDIAN_API_PROXY || 'http://127.0.0.1:8787',
        },
      },
    },
    build: { target: 'es2022' },
  };
});
