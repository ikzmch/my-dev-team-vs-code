import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Inline `.md` imports as plain strings, mirroring esbuild's text loader that
 * the production bundle uses for the system-prompt files in config/prompts.
 * Without this, importing the agents (which pull in those prompts) would fail
 * under Vitest.
 */
const markdownAsText = {
  name: 'markdown-as-text',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (id.endsWith('.md')) {
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    }
  },
};

// The extension source imports the `vscode` module, which only exists inside a
// running editor. For unit tests we alias it to an in-memory fake (see
// test/mocks/vscode.ts) so the pure logic can be exercised in plain Node.
export default defineConfig({
  plugins: [markdownAsText],
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
