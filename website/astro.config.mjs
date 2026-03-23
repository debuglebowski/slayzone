import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://slay.zone',
  output: 'static',
  outDir: './dist',
  publicDir: './.astro-public',
  image: {
    remotePatterns: [],
  },
  build: {
    format: 'file',
  },
})
