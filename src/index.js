import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.OLLAMA_MODEL?.trim() || null;
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 180_000);

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function ollamaFetch(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    const bodyText = await response.text();
    let body;

    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = bodyText;
    }

    if (!response.ok) {
      const detail = typeof body === 'string' ? body : JSON.stringify(body);
      throw new Error(`Ollama HTTP ${response.status}: ${detail}`);
    }

    return body;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Ollama request timed out after ${OLLAMA_TIMEOUT_MS} ms`);
    }

    if (error instanceof TypeError && String(error.message).toLowerCase().includes('fetch')) {
      throw new Error(`Cannot reach Ollama at ${OLLAMA_BASE_URL}. Is Ollama running?`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function listModels() {
  const payload = await ollamaFetch('/api/tags', { method: 'GET' });
  return Array.isArray(payload?.models) ? payload.models : [];
}

async function resolveModel(requestedModel) {
  if (requestedModel?.trim()) return requestedModel.trim();
  if (DEFAULT_MODEL) return DEFAULT_MODEL;

  const models = await listModels();
  const names = models.map((model) => model.name).filter(Boolean);
  const ornith = names.find((name) => /ornith/i.test(name));

  if (ornith) return ornith;

  if (names.length === 1) return names[0];

  throw new Error(
    `No Ollama model selected. Set OLLAMA_MODEL or pass model explicitly. Available models: ${names.join(', ') || '(none)'}`,
  );
}

function createServer() {
  const server = new McpServer({
    name: 'local-integrator',
    version: '0.1.0',
  });

  server.registerTool(
    'ollama_models',
    {
      description: 'List models currently installed in the local Ollama instance.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const models = await listModels();

        if (models.length === 0) {
          return textResult(`Ollama is reachable at ${OLLAMA_BASE_URL}, but no local models were found.`);
        }

        const lines = models.map((model) => {
          const details = model.details ?? {};
          const bits = [details.parameter_size, details.quantization_level].filter(Boolean).join(', ');
          return `- ${model.name}${bits ? ` (${bits})` : ''}`;
        });

        return textResult(`Ollama: ${OLLAMA_BASE_URL}\n${lines.join('\n')}`);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  server.registerTool(
    'ornith_ask',
    {
      description:
        'Ask a local Ollama model (preferably Ornith) for an independent analysis. Useful as a cheap local reviewer, counterexample finder, summarizer, or second opinion.',
      inputSchema: z.object({
        prompt: z.string().min(1).describe('The task or question to send to the local model.'),
        system: z.string().optional().describe('Optional system instruction for the local model.'),
        model: z.string().optional().describe('Optional Ollama model name/tag. Overrides OLLAMA_MODEL.'),
        think: z.boolean().optional().describe('Enable/disable Ollama thinking mode when supported by the model.'),
        temperature: z.number().min(0).max(2).optional().describe('Optional sampling temperature from 0 to 2.'),
      }),
    },
    async ({ prompt, system, model, think, temperature }) => {
      try {
        const selectedModel = await resolveModel(model);
        const messages = [];

        if (system?.trim()) {
          messages.push({ role: 'system', content: system.trim() });
        }

        messages.push({ role: 'user', content: prompt });

        const request = {
          model: selectedModel,
          messages,
          stream: false,
          ...(typeof think === 'boolean' ? { think } : {}),
          ...(typeof temperature === 'number' ? { options: { temperature } } : {}),
        };

        const response = await ollamaFetch('/api/chat', {
          method: 'POST',
          body: JSON.stringify(request),
        });

        const answer = response?.message?.content?.trim();
        const thinking = response?.message?.thinking?.trim();
        const stats = [
          Number.isFinite(response?.prompt_eval_count) ? `prompt=${response.prompt_eval_count}` : null,
          Number.isFinite(response?.eval_count) ? `output=${response.eval_count}` : null,
        ]
          .filter(Boolean)
          .join(', ');

        const parts = [
          `model: ${selectedModel}${stats ? ` (${stats})` : ''}`,
          thinking ? `thinking:\n${thinking}` : null,
          answer ? `answer:\n${answer}` : 'answer: (empty response)',
        ].filter(Boolean);

        return textResult(parts.join('\n\n'));
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  );

  return server;
}

void serveStdio(createServer);
console.error(`local-integrator MCP ready; Ollama=${OLLAMA_BASE_URL}; model=${DEFAULT_MODEL ?? 'auto'}`);
