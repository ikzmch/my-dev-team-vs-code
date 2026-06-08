/**
 * Central registry of system prompts. The prose lives in sibling `.md` files
 * so it can be authored and reviewed as plain Markdown; esbuild's text loader
 * inlines each one as a string at build time (see package.json `package`
 * script and prompts/markdown.d.ts). Agents import from here, never from the
 * `.md` files directly, so the loading mechanism stays in one place.
 */
import intentClassifier from './prompts/intentClassifier.md';
import planner from './prompts/planner.md';

export const prompts = {
  intentClassifier,
  planner,
} as const;

export type PromptName = keyof typeof prompts;
