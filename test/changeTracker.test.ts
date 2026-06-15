import { describe, it, expect } from 'vitest';
import { ChangeTracker } from '../src/client/changeTracker';

describe('ChangeTracker', () => {
  it('sums distinct files into one summary', () => {
    const tracker = new ChangeTracker();
    const session = tracker.openSession();
    tracker.report('a.ts', '', 'one\ntwo\nthree'); // create: +3
    tracker.report('b.ts', 'x\ny', 'x'); // delete a line: -1
    expect(session.summary()).toEqual({ files: 2, added: 3, removed: 1 });
  });

  it('nets multiple writes to one file instead of double-counting', () => {
    const tracker = new ChangeTracker();
    const session = tracker.openSession();
    // The executor writes the file, then edits it: the net change is the first
    // "before" against the latest "after", counted once.
    tracker.report('a.ts', 'a\nb', 'a\nb\nc'); // first touch, before = 'a\nb'
    tracker.report('a.ts', 'a\nb\nc', 'a\nb\nc\nd'); // latest after = 4 lines
    expect(session.summary()).toEqual({ files: 1, added: 2, removed: 0 });
  });

  it('drops a file rewritten back to identical content', () => {
    const tracker = new ChangeTracker();
    const session = tracker.openSession();
    tracker.report('a.ts', 'same', 'same');
    expect(session.summary()).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it('ignores a report when no session is open', () => {
    const tracker = new ChangeTracker();
    expect(() => tracker.report('a.ts', '', 'x')).not.toThrow();
  });

  it('attributes a report to the newest open session only', () => {
    const tracker = new ChangeTracker();
    const first = tracker.openSession();
    const second = tracker.openSession();
    tracker.report('a.ts', '', 'x\ny');
    expect(second.summary()).toEqual({ files: 1, added: 2, removed: 0 });
    expect(first.summary()).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it('routes to the prior session once the newest one is disposed', () => {
    const tracker = new ChangeTracker();
    const first = tracker.openSession();
    const second = tracker.openSession();
    second.dispose();
    tracker.report('a.ts', '', 'x');
    expect(first.summary()).toEqual({ files: 1, added: 1, removed: 0 });
  });

  it('still reports a disposed session\'s collected changes', () => {
    const tracker = new ChangeTracker();
    const session = tracker.openSession();
    tracker.report('a.ts', '', 'x\ny\nz');
    session.dispose();
    expect(session.summary()).toEqual({ files: 1, added: 3, removed: 0 });
  });
});
