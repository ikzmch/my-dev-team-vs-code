/**
 * Build-time expansion of `glob:` markdown imports, shared by the esbuild
 * bundle (esbuild.mjs) and the Vitest config (vitest.config.ts).
 *
 * `import files from 'glob:./models/*.md'` resolves to a string[] of the
 * matching files' raw contents, in filename order. Discovery happens when the
 * bundle (or test run) is built, so adding a `.md` config file registers it
 * with no code change and the extension still ships with no runtime file I/O.
 *
 * Only the `dir/*.md` pattern shape is supported — enough for the config
 * folders, with no glob dependency.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Expand an absolute `dir/*.md` pattern into ES module code exporting the
 * matched files' contents as a string[].
 */
export function mdGlobModule(absPattern) {
  if (path.basename(absPattern) !== '*.md') {
    throw new Error(`Only "dir/*.md" glob imports are supported, got "${absPattern}".`);
  }
  const dir = path.dirname(absPattern);
  const contents = readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => readFileSync(path.join(dir, file), 'utf8'));
  return { dir, code: `export default ${JSON.stringify(contents)};` };
}
