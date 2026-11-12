import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: process.env.REIND_URL || 'http://127.0.0.1:8920', changeOrigin: true, configure(proxy) { proxy.on('proxyReq', req => req.removeHeader('origin')) } },
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules\/(?:react|react-dom|scheduler)\// },
            { name: 'mui', test: /node_modules\/(?:@mui|@emotion)\// },
          ],
        },
      },
    },
  },
})
