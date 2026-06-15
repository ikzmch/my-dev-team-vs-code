/**
 * Per-file test setup. The engine reads user settings through the injected
 * runtime-config seam (src/config/runtimeConfig.ts) rather than `config/settings`
 * directly. In production the client injects a live view at activation; here we
 * do the same, so engine tests that drive config via `__setConfig` on the vscode
 * mock keep working transparently (the live view delegates to `settings`, which
 * reads the mock).
 */
import { setRuntimeConfig } from '../src/config/runtimeConfig';
import { liveRuntimeConfig } from '../src/config/settings';

setRuntimeConfig(liveRuntimeConfig());
