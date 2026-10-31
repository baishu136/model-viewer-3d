import { defineConfig } from 'electron-vite'
import { resolve } from 'path'
import { modelOnlyFbx } from './scripts/model-only-fbx'

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    plugins: [modelOnlyFbx()],
    // Keep the loader visible to the model-only adapter in development as well.
    optimizeDeps: { exclude: ['three/examples/jsm/loaders/FBXLoader.js'] },
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
