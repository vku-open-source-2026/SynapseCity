import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    allowedHosts: ['synapsecity.sbs', 'contribution.synapsecity.sbs', 'openinfra.space', 'contribution.openinfra.space']
  }
})
