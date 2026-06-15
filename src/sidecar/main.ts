/**
 * The sidecar child entry point: a plain Node process that hosts the engine and
 * talks to the extension over `child_process` IPC. It wires the transport-neutral
 * `createChildRuntime` (sidecar/childRuntime.ts) to `process.send`/`process.on`
 * and constructs a real `LocalEngine`.
 *
 * This module - and everything it pulls in - must never import `vscode`: it runs
 * outside the editor. That holds because the engine reads its config through the
 * injected `config/runtimeConfig.ts` seam and its secrets from environment
 * variables, so nothing in the engine reaches into the editor's APIs. esbuild
 * bundles this to `dist/sidecar.js` (see esbuild.mjs).
 */
import { LocalEngine } from '../engine/localEngine';
import { createChildRuntime } from './childRuntime';
import { ParentMessage } from './transport';

const send = (msg: unknown): void => {
  process.send?.(msg);
};

const handle = createChildRuntime(send, () => new LocalEngine());

process.on('message', (msg) => handle(msg as ParentMessage));

// If the parent goes away, exit rather than linger as an orphan.
process.on('disconnect', () => process.exit(0));
