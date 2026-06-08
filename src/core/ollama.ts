/**
 * Minimal Ollama HTTP client. Talks to a locally running Ollama daemon
 * (default http://localhost:11434) via the /api/chat endpoint.
 *
 * Non-streaming on purpose: classification calls are short, and streaming
 * adds parsing complexity we do not need yet. When we move to real answers
 * we can add a streaming variant.
 */

const DEFAULT_BASE_URL = 'http://localhost:11434';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatOptions {
  /** Request a JSON-shaped response. The model is instructed to emit only JSON. */
  format?: 'json';
  /** 0.0 - 1.0. Low values make classification deterministic. */
  temperature?: number;
}

export class OllamaClient {
  constructor(
    private readonly model: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL
  ) {}

  async chat(
    messages: OllamaMessage[],
    options: OllamaChatOptions = {}
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      // qwen3 emits <think> blocks by default; disable for tasks where we
      // only care about the structured output. Newer Ollama honours this;
      // older versions ignore unknown fields.
      think: false,
      options: {
        temperature: options.temperature ?? 0.1,
      },
    };
    if (options.format) {
      body.format = options.format;
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${errBody}`);
    }

    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? '';
  }
}
