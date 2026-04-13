import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';
import mdx from '@astrojs/mdx';
import typography from '@tailwindcss/typography';

export default defineConfig({
  adapter: process.env.NODE_ENV === 'production' ? cloudflare() : undefined,
  integrations: [mdx()],
  vite: {
    plugins: [
      tailwindcss({
        config: {
          plugins: [typography],
        },
      }),
    ],
    ssr: {
      external: ['mongodb'],  // ← add this
    },
    optimizeDeps: {
      exclude: ['mongodb'],   // ← and this
    }
  },
});