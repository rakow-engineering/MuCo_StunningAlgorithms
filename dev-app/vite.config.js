import { defineConfig } from 'vite';
import { resolve } from 'path';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Vite injects `crossorigin` on built script/link tags for preload/CORS consistency.
 * On `file://` that forces a CORS fetch, which browsers block (origin `null`), so
 * local `dist/index.html` cannot load `./assets/*`. Strip it only for production HTML.
 */
function stripBuiltHtmlCrossorigin() {
  return {
    name: 'strip-built-html-crossorigin',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin/g, '');
    }
  };
}

export default defineConfig(({ mode }) => {
  /** `vite build --mode file` — one inlined HTML for opening via `file://` (no separate module script). */
  const fileBundle = mode === 'file';

  return {
    // Relative URLs so `dist/` can be served from a subpath or copied as a folder.
    base: './',
    build: fileBundle
      ? { outDir: 'dist-file', emptyOutDir: true }
      : undefined,
    plugins: [
      stripBuiltHtmlCrossorigin(),
      ...(fileBundle ? [viteSingleFile()] : [])
    ],
    resolve: {
      alias: {
        '@algo': resolve(__dirname, '..')
      }
    }
  };
});
