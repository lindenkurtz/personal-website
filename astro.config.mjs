import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  adapter: process.env.NODE_ENV === 'production' ? cloudflare() : undefined,
  vite: {
    plugins: [tailwindcss()],
  },  
});