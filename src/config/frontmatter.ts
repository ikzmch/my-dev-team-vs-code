/**
 * Minimal frontmatter parser for the `.md` config files in config/agents and
 * config/tools. Supports only the YAML subset those files use — scalar
 * `key: value` pairs and block lists of strings — so the extension bundle
 * does not need a full YAML dependency. Callers validate the parsed data
 * with a zod schema, so unknown keys or missing fields fail fast on import.
 */
export type FrontmatterValue = string | number | boolean | string[];
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
  // Set while consuming the items of a block list, e.g. `tools:` then `- read`.
  let listKey: string | undefined;

  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && listKey) {
      (data[listKey] as string[]).push(String(parseScalar(item[1])));
      continue;
    }

    const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!pair) {
      throw new Error(`Unsupported frontmatter line: "${line}"`);
    }
    const [, key, value] = pair;
    if (value === '' || value === '[]') {
      data[key] = [];
      listKey = value === '' ? key : undefined;
    } else {
      data[key] = parseScalar(value);
      listKey = undefined;
    }
  }

  return { data, body: raw.slice(match[0].length).replace(/^\s*\n/, '') };
}
