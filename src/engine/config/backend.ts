/**
 * The universal backend config: operator-owned settings the engine enforces,
 * distinct from the user's VS Code settings (config/settings.ts). It ships as a
 * single JSON file (`backend.json`) bundled into the build - the engine reads no
 * file at runtime, so this is the backend equivalent of the model/tool `.md`
 * configs: edit the file, rebuild, and the new floor takes effect.
 *
 * Today the "backend" runs in-process on the client, so the file ships with the
 * extension; a future remote backend would carry the same file server-side. It
 * is deliberately namespaced (a `models` section here, room for `tools`,
 * `limits`, ... later) and every field defaults to empty, so a partial or empty
 * file is valid and new sections can be added without breaking older ones.
 *
 * Two sections today:
 *  - `models`: the providers and individual models the operator has disabled. A
 *    disabled provider/model is an *unbypassable* floor - the router never
 *    routes to it and a user pin cannot resurrect it (see the enabled predicate
 *    in core/models.ts). The per-user equivalent is the
 *    `myDevTeam.disabledProviders`/`disabledModels` settings, which narrow
 *    further but can never re-enable what the backend disabled.
 *  - `providers`: per-provider endpoint overrides (Ollama's `endpoint`, the
 *    cloud providers' `baseUrl`). An override here *wins over* the matching user
 *    setting (`myDevTeam.ollama.endpoint`, `myDevTeam.<provider>.baseUrl`), so an
 *    operator can pin every provider at a corporate gateway. An empty/blank value
 *    means "no override - fall back to the user setting"; the resolution lives in
 *    core/models.ts.
 *  - `agents.triage.model`: how the (always-engine-side) triage classifier is
 *    routed. A registered model id pins that exact model; a provider name (e.g.
 *    "ollama", "anthropic") routes by capability among that provider's models;
 *    the default is the "ollama" provider (the local models, triage's historic
 *    home). The resolution lives in core/models.ts (`triageRouting`).
 */
import { z } from 'zod';
import rawBackendConfig from './backend.json';

/** A list of provider/model identifiers, defaulting to empty when omitted. */
const idList = z.array(z.string()).default([]);

/**
 * A provider endpoint override: an http(s) URL with any trailing slash trimmed,
 * or undefined when omitted/blank (meaning "no override"). A non-blank value
 * that is not an http(s) URL fails validation at load, a loud error the operator
 * fixes - rather than silently ignoring a typo'd gateway.
 */
const endpointOverride = z
  .string()
  .optional()
  .transform((value) => (value ?? '').trim().replace(/\/+$/, ''))
  .refine((value) => value === '' || /^https?:\/\/.+/.test(value), {
    message: 'a provider endpoint override must be an http(s) URL',
  })
  .transform((value) => (value === '' ? undefined : value));

/**
 * An agent's routing choice: a registered model id or a provider name. It is a
 * free string (the model registry is not known here), resolved leniently at
 * runtime; blank/omitted defaults to the "ollama" provider - triage's home.
 */
const modelOrProvider = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = (value ?? '').trim();
    return trimmed === '' ? 'ollama' : trimmed;
  });

export const BackendConfigSchema = z
  .object({
    /** Model-router floor: providers and model ids the operator disabled. */
    models: z
      .object({
        /** Provider names (e.g. "anthropic") the router must never use. */
        disabledProviders: idList,
        /** Registered model ids (e.g. "qwen3-coder") the router must never use. */
        disabledModels: idList,
      })
      // prefault (not default): a missing section parses from `{}`, so the inner
      // field defaults still fill the empty arrays.
      .prefault({}),
    /** Per-provider endpoint overrides; each wins over its user setting. */
    providers: z
      .object({
        /** Ollama server origin (no `/api` suffix), like `myDevTeam.ollama.endpoint`. */
        ollama: z.object({ endpoint: endpointOverride }).prefault({}),
        /** OpenAI base URL, like `myDevTeam.openai.baseUrl`. */
        openai: z.object({ baseUrl: endpointOverride }).prefault({}),
        /** Anthropic base URL, like `myDevTeam.anthropic.baseUrl`. */
        anthropic: z.object({ baseUrl: endpointOverride }).prefault({}),
        /** Groq base URL, like `myDevTeam.groq.baseUrl`. */
        groq: z.object({ baseUrl: endpointOverride }).prefault({}),
      })
      .prefault({}),
    /** Per-agent routing config. Today only triage is configurable. */
    agents: z
      .object({
        triage: z
          .object({
            /**
             * A registered model id (pin that exact model) or a provider name
             * (route by capability within it); blank/omitted falls back to the
             * "ollama" provider.
             */
            model: modelOrProvider,
          })
          .prefault({}),
      })
      .prefault({}),
  })
  .prefault({});

export type BackendConfig = z.infer<typeof BackendConfigSchema>;

/**
 * The parsed, validated backend config. An invalid file fails the build's first
 * load (a loud, early failure the operator fixes), rather than silently
 * degrading the floor.
 */
export const backendConfig: BackendConfig = BackendConfigSchema.parse(rawBackendConfig);
