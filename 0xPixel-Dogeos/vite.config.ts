import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], base: '/DOGEOSxPIXEL/', server: { host: '127.0.0.1' }, build: { rollupOptions:{output:{manualChunks:{react:['react','react-dom'],chain:['viem']}}} } });
