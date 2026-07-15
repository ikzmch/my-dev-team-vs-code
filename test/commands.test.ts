import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  commandConfigs,
  commandNames,
  loadCommands,
  pinnedReason,
} from '../src/engine/config/commands';
import { ASK_COMMAND, clientCommands, COMPACT_COMMAND } from '../src/config/clientCommands';

function commandFile(frontmatter: string, body = ''): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

describe('command configs', () => {
  it('parses frontmatter and the preamble body', () => {
    const [command] = loadCommands([
      commandFile(
        'name: fix\ndescription: Fix a bug.\nintent: planning',
        'Diagnose first.'
      ),
    ]);
    expect(command).toEqual({
      name: 'fix',
      description: 'Fix a bug.',
      intent: 'planning',
      execute: true,
      complexity: 'moderate',
      preamble: 'Diagnose first.',
    });
  });

  it('defaults execute to true and honours an explicit false', () => {
    const [plan, doIt] = loadCommands([
      commandFile('name: plan\ndescription: Plan only.\nintent: planning\nexecute: false'),
      commandFile('name: do\ndescription: Do it.\nintent: planning'),
    ]);
    expect(plan.execute).toBe(false);
    expect(doIt.execute).toBe(true);
  });

  it('defaults complexity to moderate and honours an explicit value', () => {
    const [doIt, fix] = loadCommands([
      commandFile('name: do\ndescription: Do it.\nintent: planning'),
      commandFile('name: fix\ndescription: Fix.\nintent: planning\ncomplexity: complex'),
    ]);
    expect(doIt.complexity).toBe('moderate');
    expect(fix.complexity).toBe('complex');
  });

  it('rejects a complexity the protocol does not know', () => {
    expect(() =>
      loadCommands([
        commandFile('name: x\ndescription: X.\nintent: planning\ncomplexity: trivial'),
      ])
    ).toThrow();
  });

  it('rejects an intent the protocol does not know', () => {
    expect(() =>
      loadCommands([commandFile('name: x\ndescription: X.\nintent: chat')])
    ).toThrow();
  });

  it('rejects duplicate command names', () => {
    const file = commandFile('name: fix\ndescription: Fix.\nintent: planning');
    expect(() => loadCommands([file, file])).toThrow(/Duplicate command name "fix"/);
  });

  it('registers the discovered commands keyed by name', () => {
    expect(commandNames).toEqual([
      'ask',
      'compact',
      'do',
      'explain',
      'fix',
      'plan',
      'review',
      'test',
    ]);
    for (const name of commandNames) {
      expect(commandConfigs[name]?.name).toBe(name);
    }
  });

  it('pins oneshot commands to oneshot and planning commands to planning', () => {
    for (const name of ['ask', 'compact', 'explain', 'review']) {
      expect(commandConfigs[name].intent).toBe('oneshot');
    }
    for (const name of ['do', 'fix', 'plan', 'test']) {
      expect(commandConfigs[name].intent).toBe('planning');
    }
  });

  it('only /plan opts out of execution', () => {
    expect(commandConfigs.plan.execute).toBe(false);
    for (const name of commandNames.filter((n) => n !== 'plan')) {
      expect(commandConfigs[name].execute).toBe(true);
    }
  });

  it('names the command in the pinned triage reason', () => {
    expect(pinnedReason('fix')).toBe('Requested via /fix.');
  });
});

describe('client commands', () => {
  it('keeps client and engine command names disjoint', () => {
    // A name in both lists would be ambiguous: the handler would answer it
    // client-side and the engine config would never run.
    for (const { name } of clientCommands) {
      expect(commandConfigs[name]).toBeUndefined();
    }
  });

  it('points the compact history marker at a registered oneshot engine command', () => {
    // The client may not import engine internals, so it repeats the name;
    // this is the guard that the engine actually knows it.
    expect(commandConfigs[COMPACT_COMMAND]?.intent).toBe('oneshot');
  });

  it('points the side-question command at a registered oneshot engine command', () => {
    // Same rule as COMPACT_COMMAND: the client repeats the /ask name for its
    // history filtering and the quick-question run, so the engine must know it
    // and answer it in one shot (a side question never plans or executes).
    expect(commandConfigs[ASK_COMMAND]?.intent).toBe('oneshot');
    expect(commandConfigs[ASK_COMMAND]?.complexity).toBe('simple');
  });
});

describe('package.json command declarations', () => {
  // VS Code's command autocomplete reads the static package.json list; the
  // engine reads the discovered .md configs and the client its own list.
  // This is the drift guard between the three (matching how the planner's
  // tool enum is tied to the registry).
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
  ) as {
    contributes: {
      chatParticipants: Array<{
        commands?: Array<{ name: string; description: string }>;
      }>;
    };
  };
  const declared = pkg.contributes.chatParticipants[0].commands ?? [];
  const known = new Map<string, string>([
    ...commandNames.map((name): [string, string] => [
      name,
      commandConfigs[name].description,
    ]),
    ...clientCommands.map((c): [string, string] => [c.name, c.description]),
  ]);

  it('declares exactly the engine and client commands', () => {
    expect(declared.map((c) => c.name).sort()).toEqual([...known.keys()].sort());
  });

  it('declares each command with its config description', () => {
    for (const { name, description } of declared) {
      expect(description).toBe(known.get(name));
    }
  });
});
