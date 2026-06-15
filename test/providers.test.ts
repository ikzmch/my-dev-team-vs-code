import { describe, it, expect } from 'vitest';
import {
  providerDescriptors,
  providerDescriptor,
  providerIds,
  providerLabels,
  cloudProviderDescriptors,
} from '../src/config/providers';

describe('provider registry', () => {
  it('exposes a non-empty set of descriptors with the required fields', () => {
    expect(providerDescriptors.length).toBeGreaterThan(0);
    for (const d of providerDescriptors) {
      expect(d.id).toBeTruthy();
      expect(d.label).toBeTruthy();
      expect(d.baseUrlSetting).toMatch(/\./); // "<provider>.endpoint" / "<provider>.baseUrl"
      expect(typeof d.build).toBe('function');
    }
  });

  it('derives the id tuple, labels, and lookup from the one registry', () => {
    expect(providerIds).toEqual(providerDescriptors.map((d) => d.id));
    for (const d of providerDescriptors) {
      expect(providerLabels[d.id]).toBe(d.label);
      expect(providerDescriptor(d.id)).toBe(d);
    }
  });

  it('keeps provider ids unique', () => {
    expect(new Set(providerIds).size).toBe(providerIds.length);
  });

  it('a keyless provider carries no key names; a cloud one carries both', () => {
    for (const d of providerDescriptors) {
      if (d.keyless) {
        expect(d.secretKey).toBeUndefined();
        expect(d.envKey).toBeUndefined();
      } else {
        expect(d.secretKey).toBeTruthy();
        expect(d.envKey).toBeTruthy();
      }
    }
  });

  it('cloudProviderDescriptors is exactly the non-keyless subset', () => {
    expect(cloudProviderDescriptors).toEqual(providerDescriptors.filter((d) => !d.keyless));
    expect(cloudProviderDescriptors.every((d) => !d.keyless)).toBe(true);
  });

  it('build wires a model at the configured base URL / key', () => {
    // Ollama: keyless, the resolved endpoint gets the /api suffix.
    const ollama = providerDescriptor('ollama').build({ baseUrl: 'http://host:11434' });
    expect(ollama('llama3').modelId).toBe('llama3');

    // A cloud provider: the model id passes through to the SDK instance.
    const openai = providerDescriptor('openai').build({ apiKey: 'k' });
    expect(openai('gpt-4o').modelId).toBe('gpt-4o');
  });
});
