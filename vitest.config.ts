import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// @ts-expect-error — plain .mjs helper shared with esbuild.mjs, no types.
import { mdGlobModule } from './md-glob.mjs';

/**
 * Inline `.md` imports as plain strings, mirroring esbuild's text loader that
 * the production bundle uses for the config files in config/agents and
 * config/tools. Without this, importing the agents (which pull in those
 * configs) would fail under Vitest.
 */
const markdownAsText = {
  name: 'markdown-as-text',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    // Skip virtual modules (e.g. resolved md-glob ids, which also end in .md).
    if (id.endsWith('.md') && !id.startsWith('\0')) {
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    }
  },
};

const GLOB_PREFIX = 'glob:';
const RESOLVED_GLOB_PREFIX = '\0md-glob:';

/**
 * Expand `glob:./dir/*.md` imports into string arrays of the matched files'
 * contents, mirroring the md-glob esbuild plugin (see esbuild.mjs) that the
 * production bundle uses for the config folders.
 */
const markdownGlob = {
  name: 'md-glob',
  enforce: 'pre' as const,
  resolveId(source: string, importer: string | undefined) {
    if (source.startsWith(GLOB_PREFIX) && importer) {
      const pattern = source.slice(GLOB_PREFIX.length);
      return RESOLVED_GLOB_PREFIX + path.resolve(path.dirname(importer), pattern);
    }
  },
  load(id: string) {
    if (id.startsWith(RESOLVED_GLOB_PREFIX)) {
      return mdGlobModule(id.slice(RESOLVED_GLOB_PREFIX.length)).code;
    }
  },
};

// The extension source imports the `vscode` module, which only exists inside a
// running editor. For unit tests we alias it to an in-memory fake (see
// test/mocks/vscode.ts) so the pure logic can be exercised in plain Node.
export default defineConfig({
  plugins: [markdownGlob, markdownAsText],
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./test/mocks/vscode.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    clearMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});
