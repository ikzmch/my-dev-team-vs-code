/**
 * Lets TypeScript treat `import foo from './foo.md'` as a string. esbuild's
 * text loader (`--loader:.md=text`, see package.json) inlines the file's
 * contents into the bundle at build time, so agent and tool config prose
 * lives in `.md` files (config/agents, config/tools) but ships as a plain
 * string with no runtime file I/O.
 */
declare module '*.md' {
  const content: string;
  export default content;
}

/**
 * `import files from 'glob:./dir/*.md'` — the contents of every `.md` file in
 * the directory, in filename order, discovered at build time by the md-glob
 * plugin (esbuild.mjs for the bundle, vitest.config.ts for tests).
 */
declare module 'glob:*' {
  const contents: string[];
  export default contents;
}
