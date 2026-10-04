import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'example',
  plugins: [tailwindcss()],
  build: { outDir: '../example-dist', emptyOutDir: true },
})
