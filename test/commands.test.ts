import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  commandConfigs,
  commandNames,
  loadCommands,
  pinnedReason,
} from '../src/engine/config/commands';

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
    expect(commandNames).toEqual(['do', 'explain', 'fix', 'plan', 'review', 'test']);
    for (const name of commandNames) {
      expect(commandConfigs[name]?.name).toBe(name);
    }
  });

  it('pins oneshot commands to oneshot and planning commands to planning', () => {
    expect(commandConfigs.explain.intent).toBe('oneshot');
    expect(commandConfigs.review.intent).toBe('oneshot');
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

describe('package.json command declarations', () => {
  // VS Code's command autocomplete reads the static package.json list, the
  // engine reads the discovered .md configs; this is the drift guard between
  // the two (matching how the planner's tool enum is tied to the registry).
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

  it('declares exactly the discovered commands', () => {
    expect(declared.map((c) => c.name).sort()).toEqual([...commandNames].sort());
  });

  it('declares each command with its config description', () => {
    for (const { name, description } of declared) {
      expect(description).toBe(commandConfigs[name]?.description);
    }
  });
});
