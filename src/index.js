import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.OLLAMA_MODEL?.trim() || null;
const OLLAMA_TIMEOUT_MS = readPositiveInt('OLLAMA_TIMEOUT_MS', 180_000);
const ORNITH_MAX_INPUT_CHARS = readPositiveInt('ORNITH_MAX_INPUT_CHARS', 60_000);
const ORNITH_NUM_PREDICT = readPositiveInt('ORNITH_NUM_PREDICT', 1_536);
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE?.trim() || '15m';
const DEFAULT_THINK = /^(1|true|yes|on)$/i.test(process.env.ORNITH_THINK ?? 'false');

const REVIEWER_SYSTEM = [
  'You are a bounded independent code reviewer working from supplied context only.',
  'Do not explore the filesystem, invent unseen repository state, or claim that you ran commands/tests.',
  'Prefer concrete correctness, regression, security, and edge-case findings over style comments.',
  'If the supplied context is insufficient, say exactly what evidence is missing.',
  'Return concise conclusions and evidence, not hidden chain-of-thought.',
].join(' ');

function readPositiveInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function assertInputBudget(label, values) {
  const chars = values.reduce((sum, value) => sum + (typeof value === 'string' ? value.length : 0), 0);

  if (chars > ORNITH_MAX_INPUT_CHARS) {
    throw new Error(
      `${label} input is ${chars.toLocaleString()} chars, above the ${ORNITH_MAX_INPUT_CHARS.toLocaleString()} char budget. ` +
        'Narrow the relevant files/diff before calling Ornith; do not send the whole repository.',
    );
  }

  return chars;
}

function formatDuration(ns) {
  if (!Number.isFinite(ns)) return null;
  return `${(ns / 1_000_000_000).toFixed(2)}s`;
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

async function askOllama({
  prompt,
  system,
  model,
  think,
  temperature = 0.1,
  maxOutputTokens,
  budgetLabel = 'ornith',
}) {
  const inputChars = assertInputBudget(budgetLabel, [system, prompt]);
  const selectedModel = await resolveModel(model);
  const messages = [];

  if (system?.trim()) {
    messages.push({ role: 'system', content: system.trim() });
  }

  messages.push({ role: 'user', content: prompt });

  const numPredict = Math.min(Math.max(maxOutputTokens ?? ORNITH_NUM_PREDICT, 128), 4_096);
  const request = {
    model: selectedModel,
    messages,
    stream: false,
    think: typeof think === 'boolean' ? think : DEFAULT_THINK,
    keep_alive: OLLAMA_KEEP_ALIVE,
    options: {
      temperature,
      num_predict: numPredict,
    },
  };

  const response = await ollamaFetch('/api/chat', {
    method: 'POST',
    body: JSON.stringify(request),
  });

  const answer = response?.message?.content?.trim();
  const stats = [
    `inputChars=${inputChars}`,
    Number.isFinite(response?.prompt_eval_count) ? `promptTokens=${response.prompt_eval_count}` : null,
    Number.isFinite(response?.eval_count) ? `outputTokens=${response.eval_count}` : null,
    formatDuration(response?.load_duration) ? `load=${formatDuration(response.load_duration)}` : null,
    formatDuration(response?.prompt_eval_duration) ? `promptEval=${formatDuration(response.prompt_eval_duration)}` : null,
    formatDuration(response?.eval_duration) ? `generate=${formatDuration(response.eval_duration)}` : null,
    formatDuration(response?.total_duration) ? `total=${formatDuration(response.total_duration)}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return textResult(
    [`model: ${selectedModel} (${stats})`, answer ? `answer:\n${answer}` : 'answer: (empty response)'].join('\n\n'),
  );
}

function optionalRuntimeFields() {
  return {
    model: z.string().optional().describe('Optional Ollama model name/tag. Overrides OLLAMA_MODEL.'),
    think: z.boolean().optional().describe('Enable thinking mode. Defaults to ORNITH_THINK, which is false by default for speed.'),
    temperature: z.number().min(0).max(2).optional().describe('Sampling temperature. Reviewer tools default to 0.1.'),
    max_output_tokens: z.number().int().min(128).max(4096).optional().describe('Bound local-model output size.'),
  };
}

async function safeTool(handler) {
  try {
    return await handler();
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
}

function createServer() {
  const server = new McpServer({
    name: 'local-integrator',
    version: '0.2.0',
  });

  server.registerTool(
    'ollama_models',
    {
      description: 'List models currently installed in the local Ollama instance.',
      inputSchema: z.object({}),
    },
    async () =>
      safeTool(async () => {
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
      }),
  );

  server.registerTool(
    'ornith_ask',
    {
      description:
        'Ask the local model a bounded question. Supply the relevant context directly; do not ask Ornith to explore the repository/filesystem.',
      inputSchema: z.object({
        prompt: z.string().min(1).describe('Question/task plus any already-filtered context.'),
        system: z.string().optional().describe('Optional system instruction.'),
        ...optionalRuntimeFields(),
      }),
    },
    async ({ prompt, system, model, think, temperature, max_output_tokens }) =>
      safeTool(() =>
        askOllama({
          prompt,
          system,
          model,
          think,
          temperature: temperature ?? 0.1,
          maxOutputTokens: max_output_tokens,
          budgetLabel: 'ornith_ask',
        }),
      ),
  );

  server.registerTool(
    'ornith_review_diff',
    {
      description:
        'Review a diff already collected by the parent agent. Ornith receives no filesystem access; use this for fast independent regression review.',
      inputSchema: z.object({
        diff: z.string().min(1).describe('Relevant unified diff. Keep it narrow rather than sending the whole repository.'),
        objective: z.string().optional().describe('What this change is supposed to accomplish.'),
        acceptance_criteria: z.string().optional().describe('Relevant acceptance criteria/invariants.'),
        context: z.string().optional().describe('Small amount of extra code or domain context needed to understand the diff.'),
        ...optionalRuntimeFields(),
      }),
    },
    async ({ diff, objective, acceptance_criteria, context, model, think, temperature, max_output_tokens }) =>
      safeTool(() => {
        const prompt = [
          'Independently review this code diff.',
          objective ? `\nOBJECTIVE:\n${objective}` : '',
          acceptance_criteria ? `\nACCEPTANCE CRITERIA / INVARIANTS:\n${acceptance_criteria}` : '',
          context ? `\nADDITIONAL CONTEXT:\n${context}` : '',
          `\nDIFF:\n${diff}`,
          '\nOUTPUT: List only concrete findings. For each: severity, evidence, failure scenario, and the smallest regression test or fix. If no concrete bug is supported by the supplied context, say so explicitly.',
        ].join('');

        return askOllama({
          prompt,
          system: REVIEWER_SYSTEM,
          model,
          think,
          temperature: temperature ?? 0.1,
          maxOutputTokens: max_output_tokens,
          budgetLabel: 'ornith_review_diff',
        });
      }),
  );

  server.registerTool(
    'ornith_review_code',
    {
      description:
        'Review a small set of source/test snippets selected by the parent agent. Best for 2-10 relevant files instead of whole-repo exploration.',
      inputSchema: z.object({
        code: z.string().min(1).describe('Relevant source/test snippets, preferably with file-name headers.'),
        question: z.string().optional().describe('Specific review question or suspected boundary.'),
        context: z.string().optional().describe('Small business/domain context or invariant.'),
        ...optionalRuntimeFields(),
      }),
    },
    async ({ code, question, context, model, think, temperature, max_output_tokens }) =>
      safeTool(() => {
        const prompt = [
          'Review the supplied code as an independent second reviewer.',
          question ? `\nQUESTION:\n${question}` : '',
          context ? `\nCONTEXT / INVARIANTS:\n${context}` : '',
          `\nCODE:\n${code}`,
          '\nOUTPUT: Give a verdict, then concrete findings with evidence and a reproducible failure scenario. Do not speculate beyond the supplied code.',
        ].join('');

        return askOllama({
          prompt,
          system: REVIEWER_SYSTEM,
          model,
          think,
          temperature: temperature ?? 0.1,
          maxOutputTokens: max_output_tokens,
          budgetLabel: 'ornith_review_code',
        });
      }),
  );

  server.registerTool(
    'ornith_find_counterexample',
    {
      description:
        'Try to falsify a claim using only supplied implementation/tests. Useful for blind regression review and compile-valid/runtime-valid counterexample hunting.',
      inputSchema: z.object({
        claim: z.string().min(1).describe('Claim/invariant to try to falsify.'),
        code: z.string().min(1).describe('Relevant production code selected by the parent agent.'),
        tests: z.string().optional().describe('Relevant existing tests.'),
        constraints: z.string().optional().describe('Compile/runtime/domain constraints the counterexample must respect.'),
        ...optionalRuntimeFields(),
      }),
    },
    async ({ claim, code, tests, constraints, model, think, temperature, max_output_tokens }) =>
      safeTool(() => {
        const prompt = [
          'Act as an adversarial reviewer. Try to falsify the claim with the smallest concrete counterexample supported by the supplied code.',
          `\nCLAIM:\n${claim}`,
          constraints ? `\nCONSTRAINTS:\n${constraints}` : '',
          `\nIMPLEMENTATION:\n${code}`,
          tests ? `\nEXISTING TESTS:\n${tests}` : '',
          '\nOUTPUT: (1) PASS/COUNTEREXAMPLE/INSUFFICIENT EVIDENCE, (2) exact counterexample or missing evidence, (3) why current checks accept/fail it, (4) minimal regression test. Do not invent unseen code.',
        ].join('');

        return askOllama({
          prompt,
          system: REVIEWER_SYSTEM,
          model,
          think,
          temperature: temperature ?? 0,
          maxOutputTokens: max_output_tokens,
          budgetLabel: 'ornith_find_counterexample',
        });
      }),
  );

  return server;
}

void serveStdio(createServer);
console.error(
  `local-integrator MCP v0.2.0 ready; Ollama=${OLLAMA_BASE_URL}; model=${DEFAULT_MODEL ?? 'auto'}; ` +
    `maxInputChars=${ORNITH_MAX_INPUT_CHARS}; think=${DEFAULT_THINK}; keepAlive=${OLLAMA_KEEP_ALIVE}`,
);
