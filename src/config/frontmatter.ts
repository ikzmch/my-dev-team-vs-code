/**
 * Minimal frontmatter parser for the `.md` config files in config/agents,
 * config/models and config/tools. Supports only the YAML subset those files
 * use — scalar `key: value` pairs, block lists of strings, and one-level
 * nested maps of scalars — so the extension bundle does not need a full YAML
 * dependency. Callers validate the parsed data with a zod schema, so unknown
 * keys or missing fields fail fast on import.
 */
export type FrontmatterScalar = string | number | boolean;
export type FrontmatterValue =
  | FrontmatterScalar
  | string[]
  | Record<string, FrontmatterScalar>;
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedMarkdown {
  /** Key/value pairs from the `---` fenced block, if present. */
  data: Frontmatter;
  /** Everything after the frontmatter block, untrimmed except leading blank lines. */
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseScalar(text: string): string | number | boolean {
  const t = text.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
  return t;
}

export function parseFrontmatter(raw: string): ParsedMarkdown {
  const match = raw.match(FENCE);
  if (!match) {
    return { data: {}, body: raw };
  }

  const data: Frontmatter = {};
  // Set while consuming the children of a bare `key:` line. The first child
  // decides the shape: a `- item` makes it a list, a `sub: value` a map.
  let blockKey: string | undefined;

  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && blockKey) {
      const block = data[blockKey];
      if (!Array.isArray(block)) {
        throw new Error(`Cannot mix list items and map entries under "${blockKey}".`);
      }
      block.push(String(parseScalar(item[1])));
      continue;
    }

    const nested = line.match(/^\s+([A-Za-z][\w-]*):\s*(.+)$/);
    if (nested && blockKey) {
      let block = data[blockKey];
      if (Array.isArray(block)) {
        if (block.length > 0) {
          throw new Error(`Cannot mix list items and map entries under "${blockKey}".`);
        }
        // A bare `key:` defaults to an empty list; the first map entry
        // reshapes it.
        block = data[blockKey] = {};
      }
      (block as Record<string, FrontmatterScalar>)[nested[1]] = parseScalar(nested[2]);
      continue;
    }

    const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!pair) {
      throw new Error(`Unsupported frontmatter line: "${line}"`);
    }
    const [, key, value] = pair;
    if (value === '' || value === '[]') {
      data[key] = [];
      blockKey = value === '' ? key : undefined;
    } else {
      data[key] = parseScalar(value);
      blockKey = undefined;
    }
  }

  return { data, body: raw.slice(match[0].length).replace(/^\s*\n/, '') };
}
