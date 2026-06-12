/**
 * Client-side credential suppliers for the protocol's auth seam
 * (src/protocol/engine.ts AuthProvider). The LocalEngine never asks; the
 * Phase-B RemoteEngine requests credentials per run and attaches them as a
 * request header - never in the protocol body - which is what makes
 * per-request billing and rate limiting work server-side. A real provider
 * (a VS Code authentication session, or an API key in SecretStorage) slots
 * in here without touching the protocol or the engines.
 */
import { AuthProvider, Credentials } from '../protocol/engine';

/** The local default: no identity, no billing - everything runs on your machine. */
export class AnonymousAuthProvider implements AuthProvider {
  async getCredentials(): Promise<Credentials> {
    return { kind: 'anonymous' };
  }
}
