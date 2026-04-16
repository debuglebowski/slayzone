import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

export default defineConfig({
  site: 'https://slay.zone',
  output: 'static',
  outDir: './dist',
  publicDir: './public',
  integrations: [sitemap()],
  image: {
    remotePatterns: [],
  },
  trailingSlash: 'never',
  build: {
    format: 'directory',
  },
})
