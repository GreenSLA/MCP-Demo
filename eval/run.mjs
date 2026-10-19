import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { loadPrompts, ask, validateAnswer } from '../server/answer.mjs';
const stage = process.argv[2] || 'v0';
if (!['v0', 'v1', 'system-only', 'validated'].includes(stage))
  throw new Error('v0 | v1 | system-only | validated');
const corpusText = await readFile(
  new URL('questions.json', import.meta.url),
  'utf8',
);
const corpus = JSON.parse(corpusText);
const backend = process.env.EVAL_BACKEND || 'ollama';
const config =
  backend === 'ollama'
    ? {
        backend,
        model: 'qwen3.5:9b',
        temperature: 0.2,
        num_predict: 800,
        num_ctx: 16384,
        seed: 42,
        think: false,
      }
    : {
        backend,
        model: 'google/gemini-2.5-flash',
        temperature: 0.2,
        max_tokens: 1200,
        reasoning: { enabled: false },
      };
const sha = (s) => createHash('sha256').update(s).digest('hex');
let env = {};
try {
  env = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
} catch {}
const key = process.env.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY;
if (backend === 'openrouter' && !key)
  throw new Error('Set OPENROUTER_API_KEY in .env');
await mkdir(new URL('results/', import.meta.url), { recursive: true });
const out = new URL(`results/${stage}.jsonl`, import.meta.url);
let existing = [];
try {
  existing = (await readFile(out, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
} catch {}
const version = stage === 'v0' ? 'v0' : 'v1';
const prompts = loadPrompts(version, {
  fewshot: stage !== 'system-only',
  today: corpus.date,
});
const configHash = sha(
  JSON.stringify({ config, prompts, corpus: sha(corpusText) }),
);
if (existing.some((x) => x.configHash !== configHash))
  throw new Error(
    'Inputs changed; move old results before starting a new run.',
  );
let spent = 0;
for (const file of ['v0', 'v1', 'system-only', 'validated'])
  try {
    for (const row of (
      await readFile(new URL(`results/${file}.jsonl`, import.meta.url), 'utf8')
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse))
      spent += row.cost || 0;
  } catch {}
const runStartSpent = spent;
async function complete({ messages, responseFormat }) {
  if (backend === 'ollama') {
    const { num_predict, num_ctx, temperature, seed } = config;
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages: messages.map((m) =>
          m.tool_calls
            ? {
                ...m,
                tool_calls: m.tool_calls.map((c) => ({
                  ...c,
                  function: {
                    ...c.function,
                    arguments: JSON.parse(c.function.arguments),
                  },
                })),
              }
            : m,
        ),
        stream: false,
        think: false,
        keep_alive: '20m',
        options: { num_predict, num_ctx, temperature, seed },
        ...(responseFormat
          ? { format: responseFormat.json_schema.schema }
          : {}),
      }),
      signal: AbortSignal.timeout(240000),
    });
    const data = await response.json();
    if (!response.ok || data.error)
      throw new Error(data.error || 'Ollama error');
    return {
      message: data.message,
      usage: {
        prompt_tokens: data.prompt_eval_count,
        completion_tokens: data.eval_count,
        total_tokens: data.prompt_eval_count + data.eval_count,
        cost: 0,
      },
      provider: 'Ollama local',
      finish: data.done_reason,
    };
  }
  const estimate =
    Buffer.byteLength(JSON.stringify(messages)) * 0.0000003 +
    config.max_tokens * 0.0000025;
  if (spent + estimate > 0.5)
    throw new Error('Client experiment budget $0.50 reached');
  const response = await fetch(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-Title': 'ITIS E1-E5 evaluation',
      },
      body: JSON.stringify({
        ...config,
        messages,
        provider: { require_parameters: true },
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
      signal: AbortSignal.timeout(120000),
    },
  );
  const data = await response.json();
  if (!response.ok || data.error)
    throw new Error(
      `OpenRouter ${response.status}: ${data.error?.message || 'request failed'}`,
    );
  spent += data.usage?.cost ?? estimate;
  return {
    message: data.choices[0].message,
    usage: data.usage,
    generationId: data.id,
    provider: data.provider,
    finish: data.choices[0].finish_reason,
  };
}
function messagesFor(q) {
  const msgs = [
    { role: 'system', content: prompts.system },
    ...prompts.examples,
    { role: 'user', content: q.question },
  ];
  if (q.evidence.length) {
    msgs.push({
      role: 'assistant',
      content: null,
      tool_calls: q.evidence.map((e, i) => ({
        id: `source-${i}`,
        type: 'function',
        function: { name: e.name, arguments: JSON.stringify(e.arguments) },
      })),
    });
    q.evidence.forEach((e, i) =>
      msgs.push({
        role: 'tool',
        tool_call_id: `source-${i}`,
        content: JSON.stringify(e.data),
      }),
    );
  }
  return msgs;
}
const rawV1 =
  stage === 'validated'
    ? (await readFile(new URL('results/v1.jsonl', import.meta.url), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse)
    : [];
const subset = ['q01', 'q05', 'q16', 'q20', 'q23'];
for (const q of corpus.questions) {
  if (stage === 'system-only' && !subset.includes(q.id)) continue;
  if (existing.some((r) => r.id === q.id)) continue;
  const messages = messagesFor(q);
  const successfulTools = q.evidence
    .filter(
      (e) =>
        !e.isError &&
        (e.data.text?.trim() ||
          e.data.results?.length ||
          e.data.lessons?.length),
    )
    .map((e) => e.name);
  const start = Date.now(),
    calls = [];
  let row;
  if (stage === 'validated') {
    const initial = rawV1.find((r) => r.id === q.id);
    const checks = [];
    const result = await ask({
      messages,
      initialMessage: { role: 'assistant', content: initial.raw },
      successfulTools,
      onAttempt: (r) => checks.push(r),
      signal: new AbortController().signal,
      complete: async (args) => {
        const r = await complete(args);
        calls.push(r);
        return r.message;
      },
    });
    row = {
      answer: result.answer.answer,
      structured: result.answer,
      attempts: result.attempts,
      fallback: result.fallback,
      checks,
      initialInput: initial.input,
      initialOutput: initial.output,
    };
  } else {
    const r = await complete({ messages });
    calls.push(r);
    let parsed = null,
      validationError = null;
    try {
      parsed = validateAnswer(r.message.content, { successfulTools });
    } catch (e) {
      validationError = e.message;
    }
    row = {
      raw: r.message.content,
      answer: parsed?.answer || r.message.content,
      structured: parsed,
      validationError,
    };
  }
  const record = {
    id: q.id,
    question: q.question,
    origin: q.origin,
    stage,
    date: new Date().toISOString(),
    configHash,
    config,
    evidence: q.evidence,
    messages,
    ...row,
    calls,
    input: calls.reduce((n, c) => n + (c.usage?.prompt_tokens || 0), 0),
    output: calls.reduce((n, c) => n + (c.usage?.completion_tokens || 0), 0),
    cost: calls.reduce((n, c) => n + (c.usage?.cost || 0), 0),
    seconds: (Date.now() - start) / 1000,
  };
  await appendFile(out, JSON.stringify(record) + '\n');
  console.log(
    JSON.stringify({
      id: q.id,
      stage,
      input: record.input,
      output: record.output,
      valid: !!record.structured,
      cost: record.cost,
    }),
  );
}
console.log('DONE', stage, 'new USD', spent - runStartSpent, 'all USD', spent);
