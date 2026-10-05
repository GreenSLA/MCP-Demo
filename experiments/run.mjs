/** Reproducible token experiments. Never logs the API key. Node 22+. */
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { connectMcp, runAgent } from '../server/agent.mjs';
const mode = process.argv[2] || 'local';
if (!['local', 'cloud'].includes(mode))
  throw new Error('Use: node experiments/run.mjs local|cloud');
const root = new URL('../', import.meta.url);
let env = {};
try {
  env = parseEnv(await readFile(new URL('.env', root), 'utf8'));
} catch {}
const key = env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
// Pin the tested model so changing application settings cannot change the cost assumptions.
const cloudModel = 'google/gemini-2.5-flash';
const localModel = 'qwen3.5:9b';
const log = new URL(`results/${mode}.jsonl`, import.meta.url);
let spent = 0;
const MAX_CLOUD_USD = 0.3;
async function record(row) {
  await appendFile(
    log,
    JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n',
  );
  console.log(
    JSON.stringify({
      experiment: row.experiment,
      id: row.id,
      backend: row.backend,
      input: row.input,
      output: row.output,
      seconds: row.seconds,
      error: row.error,
    }),
  );
  return row;
}
async function cloud(
  messages,
  {
    maxTokens = 220,
    temperature = 0,
    experiment,
    id,
    tools,
    toolChoice,
    reasoning = false,
    ...meta
  } = {},
) {
  // Conservative UTF-8 byte estimate before each call, plus reported cost afterwards.
  const upper =
    Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') * 0.0000003 +
    maxTokens * 0.0000025;
  if (spent + upper > MAX_CLOUD_USD)
    throw new Error('Experiment cost cap reached.');
  const request = {
    model: cloudModel,
    messages,
    temperature,
    max_tokens: maxTokens,
    provider: { require_parameters: true },
    ...(tools ? { tools, tool_choice: toolChoice } : {}),
    ...(reasoning === false ? { reasoning: { enabled: false } } : {}),
  };
  const start = Date.now();
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'ITIS token experiments',
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(150000),
  });
  const data = await r.json();
  if (!r.ok || data.error) {
    await record({
      backend: 'openrouter',
      experiment,
      id,
      status: r.status,
      error: data.error?.message || 'API error',
    });
    throw new Error(
      `OpenRouter HTTP ${r.status}: ${data.error?.message || 'error'}`,
    );
  }
  const usage = data.usage || {};
  spent += usage.cost ?? upper;
  const row = await record({
    backend: 'openrouter',
    model: cloudModel,
    experiment,
    id,
    ...meta,
    temperature,
    maxTokens,
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
    total: usage.total_tokens,
    cost: usage.cost ?? null,
    usage,
    seconds: (Date.now() - start) / 1000,
    finish: data.choices?.[0]?.finish_reason,
    answer: data.choices?.[0]?.message?.content || '',
    generationId: data.id,
    provider: data.provider,
    prompt: tools ? undefined : messages,
    toolCalls: data.choices?.[0]?.message?.tool_calls,
    spentUSD: spent,
  });
  return { row, message: data.choices[0].message };
}
async function local(
  prompt,
  {
    numCtx = 8192,
    maxTokens = 220,
    temperature = 0,
    seed = 42,
    raw = false,
    experiment,
    id,
    ...meta
  } = {},
) {
  const start = Date.now();
  const request = {
    model: localModel,
    prompt,
    stream: false,
    think: false,
    raw,
    keep_alive: '10m',
    options: {
      num_ctx: numCtx,
      num_predict: maxTokens,
      temperature,
      seed,
      top_p: 1,
      top_k: 0,
      min_p: 0,
      repeat_penalty: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
    },
  };
  const r = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(240000),
  });
  const data = await r.json();
  if (!r.ok || data.error) {
    await record({ backend: 'ollama', experiment, id, error: data.error });
    throw new Error(data.error || 'Ollama error');
  }
  return record({
    backend: 'ollama',
    model: localModel,
    experiment,
    id,
    ...meta,
    temperature,
    seed,
    numCtx,
    maxTokens,
    raw,
    input: data.prompt_eval_count,
    output: data.eval_count,
    total: (data.prompt_eval_count || 0) + (data.eval_count || 0),
    seconds: (Date.now() - start) / 1000,
    finish: data.done_reason,
    answer: data.response,
    thinking: data.thinking || '',
    prompt,
    loadSeconds: data.load_duration / 1e9,
    prefillSeconds: data.prompt_eval_duration / 1e9,
    generationSeconds: data.eval_duration / 1e9,
    options: request.options,
  });
}
const pairs = [
  {
    id: 'office',
    ru: 'Это вымышленный пример, а не сведения об университете. Справка: учебный офис находится в кабинете 1505. Приём студентов: понедельник–пятница, с 09:00 до 17:00. Вопрос: где находится учебный офис и когда он принимает студентов? Ответь по-русски одним предложением, только по справке.',
    en: 'This is a fictional example, not university information. Reference: the student office is in room 1505. Student reception: Monday–Friday, from 09:00 to 17:00. Question: where is the student office and when does it receive students? Answer in English in one sentence using only the reference.',
  },
  {
    id: 'deadline',
    ru: 'Это вымышленный пример, а не сведения об университете. Справка: заявления на стипендию принимают до 20 октября. Нужны заявление и справка об обучении. Вопрос: когда заканчивается приём и какие документы нужны? Ответь по-русски одним предложением, только по справке.',
    en: 'This is a fictional example, not university information. Reference: scholarship applications are accepted until October 20. An application and a certificate of enrollment are required. Question: when is the deadline and what documents are required? Answer in English in one sentence using only the reference.',
  },
  {
    id: 'project',
    ru: 'Это вымышленный пример, а не сведения об университете. Справка: проект выполняют команды из трёх студентов. Сначала подают тему, затем прототип, затем итоговый отчёт. Вопрос: сколько человек в команде и каковы этапы работы? Ответь по-русски одним предложением, только по справке.',
    en: 'This is a fictional example, not university information. Reference: the project is completed by teams of three students. First they submit a topic, then a prototype, then a final report. Question: how many people are on a team and what are the stages? Answer in English in one sentence using only the reference.',
  },
];
const tempPrompt =
  'Вымышленное учебное объявление: для группы 11-401 занятие перенесли с 14:00 на 15:50, аудитория 1306. Составь дружелюбное сообщение студентам из двух предложений. Обязательно сохрани номер группы, старое и новое время и аудиторию. Не добавляй причин переноса и других фактов. Допускается разная формулировка.';
function contextPrompt(lines) {
  const fillers = Array.from(
    { length: lines },
    (_, i) =>
      `Record ${String(i).padStart(4, '0')}: students read notes and review ordinary course materials.`,
  );
  fillers.splice(Math.floor(lines / 2), 0, 'MIDDLE_CODE = 583027');
  return `Read the document and recover its three labeled codes.\nBEGIN_CODE = 714693\n${fillers.join('\n')}\nEND_CODE = 926481\nQuestion: Return ONLY JSON with keys begin, middle, end. Copy each corresponding code from the document. Use null if a code is unavailable. Do not invent a code.`;
}
await mkdir(new URL('results/', import.meta.url), { recursive: true });
await writeFile(log, '');
try {
  if (mode === 'local') {
    const tags = await (await fetch('http://localhost:11434/api/tags')).json();
    const show = await (
      await fetch('http://localhost:11434/api/show', {
        method: 'POST',
        body: JSON.stringify({ model: localModel }),
      })
    ).json();
    await writeFile(
      new URL('results/ollama-metadata.json', import.meta.url),
      JSON.stringify({ tags, show }, null, 2),
    );
    for (const pair of pairs)
      for (const lang of ['ru', 'en'])
        await local(pair[lang], {
          experiment: 'language',
          id: pair.id + '-' + lang,
          lang,
          pair: pair.id,
        });
    for (const temperature of [0, 0.2, 0.8, 1.4])
      for (const seed of [41, 42, 43])
        await local(tempPrompt, {
          experiment: 'temperature',
          id: `t${temperature}-s${seed}`,
          temperature,
          seed,
          maxTokens: 180,
        });
    for (const lines of [20, 100, 240, 450])
      for (const numCtx of [16384, 2048])
        await local(contextPrompt(lines), {
          experiment: 'context',
          id: `lines${lines}-ctx${numCtx}`,
          lines,
          numCtx,
          maxTokens: 80,
          temperature: 0,
        });
  }
  if (mode === 'cloud') {
    if (!key) throw new Error('No local API key.');
    const catalog = await (
      await fetch('https://openrouter.ai/api/v1/models')
    ).json();
    const model = catalog.data.find((m) => m.id === cloudModel);
    await writeFile(
      new URL('results/openrouter-metadata.json', import.meta.url),
      JSON.stringify(model, null, 2),
    );
    for (const pair of pairs)
      for (const lang of ['ru', 'en'])
        await cloud([{ role: 'user', content: pair[lang] }], {
          experiment: 'language',
          id: pair.id + '-' + lang,
          lang,
          pair: pair.id,
        });
    for (const temperature of [0, 0.2, 0.8, 1.4])
      for (let repeat = 1; repeat <= 3; repeat++)
        await cloud([{ role: 'user', content: tempPrompt }], {
          experiment: 'temperature',
          id: `t${temperature}-r${repeat}`,
          temperature,
          repeat,
          maxTokens: 180,
        });
    const mcp = await connectMcp();
    try {
      const questions = [
        'Где находится ИТИС и как связаться с институтом?',
        'Какие компании сотрудничают с ИТИС?',
        'Какие стипендиальные программы доступны студентам ИТИС?',
      ];
      for (const [i, q] of questions.entries()) {
        let call = 0;
        const events = [];
        try {
          await runAgent({
            mcp,
            key,
            model: cloudModel,
            history: [{ role: 'user', content: q }],
            signal: new AbortController().signal,
            emit: (e) => events.push(e),
            complete: async (args) =>
              (
                await cloud(args.messages, {
                  experiment: 'app',
                  id: `q${i + 1}-call${++call}`,
                  question: q,
                  session: i + 1,
                  tools: args.tools,
                  toolChoice: args.toolChoice,
                  temperature: 0.2,
                  maxTokens: 2200,
                  reasoning: null,
                })
              ).message,
          });
        } catch (e) {
          events.push({ type: 'error', message: e.message });
        }
        await writeFile(
          new URL(`results/app-${i + 1}.json`, import.meta.url),
          JSON.stringify({ question: q, events }, null, 2),
        );
      }
    } finally {
      await mcp.client.close();
    }
  }
  console.log('COMPLETE', mode, 'reported/reserved cloud USD', spent);
} catch (e) {
  console.error('EXPERIMENT STOPPED:', e.message);
  process.exitCode = 1;
}
