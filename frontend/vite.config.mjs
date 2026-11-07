import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Keep the REACT_APP_ prefix from the Create React App days so existing
  // setups (e.g. REACT_APP_API_URL=... npm start) keep working. Production
  // images set the API URL at runtime through public/config.js instead.
  envPrefix: ['VITE_', 'REACT_APP_'],
  server: {
    port: 3000,
    // Same-origin API in development, like nginx in the container.
    proxy: { '/api': 'http://localhost:8080' },
  },
  preview: { port: 3000 },
  build: {
    // nginx, the Dockerfile and `make clean` expect the bundle in build/.
    outDir: 'build',
    // recharts and the Radix primitives make one large vendor chunk; it is
    // cached across releases, so don't warn about it.
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.js'],
    include: ['src/**/*.test.{js,jsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/**/*.test.{js,jsx}', 'src/setupTests.js', 'src/test/**'],
      // The diagnosis, placement, polling and URL-state modules carry the
      // Serving and Topology logic; CI fails if any one of them drops.
      thresholds: {
        perFile: true,
        'src/lib/{api,gpuFit,pollingClock,servingCost,servingHeadroom,servingLatency,servingModels,servingPlacement,servingStatus,servingTriage,topologyLenses}.js': {
          statements: 90,
          lines: 90,
          functions: 90,
          branches: 75,
        },
        'src/hooks/{usePolling,useTopologyZoom,useUrlParam}.js': {
          statements: 90,
          lines: 90,
          functions: 90,
          branches: 75,
        },
      },
    },
  },
});
