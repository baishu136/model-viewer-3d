import { defineConfig } from 'electron-vite'
import { resolve } from 'path'
import { modelOnlyFbx } from './scripts/model-only-fbx'
import { mmdTextEncoding } from './scripts/mmd-text-encoding'

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
    plugins: [modelOnlyFbx(), mmdTextEncoding()],
    // Keep the loader visible to the model-only adapter in development as well.
    optimizeDeps: { exclude: ['three/examples/jsm/loaders/FBXLoader.js', 'three/examples/jsm/loaders/MMDLoader.js', 'three/examples/jsm/libs/mmdparser.module.js'] },
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
