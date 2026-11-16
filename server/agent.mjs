import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPrompts, ask } from './answer.mjs';
import { safeUrl } from './knowledge.mjs';
import {
  authorizeAgentTool,
  isAgentTool,
  roleAllowsTool,
  stripPromptOverrides,
  untrustedObservation,
  validatePublicAnswer,
} from './security.mjs';

const securityPrompt = readFileSync(
  new URL('../prompts/system_v5.md', import.meta.url),
  'utf8',
).trim();
const maxToolCalls = 4;

export async function connectMcp() {
  const client = new Client({ name: 'itis-navigator-agent', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))],
    stderr: 'inherit',
    env: process.env.DATABASE_URL
      ? { DATABASE_URL: process.env.DATABASE_URL }
      : undefined,
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return {
    client,
    tools: tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    })),
  };
}
export function systemPrompt() {
  return loadPrompts().system + '\n\n' + securityPrompt;
}
export async function completion({
  key,
  model,
  messages,
  tools,
  toolChoice,
  signal,
  temperature = 0.2,
  responseFormat,
  onUsage,
}) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'ITIS Navigator MCP project',
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: toolChoice,
      temperature,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      max_tokens: 2200,
      provider: { require_parameters: true },
    }),
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error(`OpenRouter вернул некорректный ответ (HTTP ${r.status}).`);
  }
  if (!r.ok || data.error) {
    const code = data.error?.code || r.status;
    const friendly = {
      401: 'OpenRouter отклонил API-ключ. Проверь его в настройках.',
      402: 'Недостаточно средств OpenRouter. Пополни баланс или выбери бесплатную модель.',
      429: 'Лимит OpenRouter или модели. Подожди немного либо выбери другую модель.',
      403: 'OpenRouter или провайдер ограничил доступ. Проверь доступность модели для своего аккаунта.',
    };
    throw new Error(
      friendly[code] ||
        `Ошибка OpenRouter (${code}). Попробуй другую модель в настройках.`,
    );
  }
  if (!data.choices?.[0]?.message)
    throw new Error('Модель вернула пустой ответ. Попробуй ещё раз.');
  onUsage?.(data.usage);
  return data.choices[0].message;
}
export async function runAgent({
  mcp,
  key,
  model,
  history,
  memory = '',
  role = 'student',
  emit,
  signal,
  audit = () => {},
  complete = completion,
}) {
  const prompts = loadPrompts();
  const system = prompts.system + '\n\n' + securityPrompt;
  const tools = mcp.tools.filter((tool) =>
    roleAllowsTool(role, tool.function.name),
  );
  const messages = [
    { role: 'system', content: system },
    ...prompts.examples,
    ...(memory
      ? [{ role: 'assistant', content: untrustedObservation(memory, 'memory') }]
      : []),
    ...history.map((message) =>
      message.role === 'assistant'
        ? { ...message, content: stripPromptOverrides(message.content) }
        : message,
    ),
  ];
  const successfulTools = new Set();
  const currentQuestion =
    history.filter((m) => m.role === 'user').at(-1)?.content || '';
  const scheduleIntent =
    /расписан|пары|11(?:\.1)?[-–—]\d{3}/i.test(currentQuestion) ||
    (/завтра|сегодня|понедельник|вторник|среду|четверг|пятницу|субботу/i.test(
      currentQuestion,
    ) &&
      history.slice(-3).some((m) => /расписан|пары/i.test(m.content)));
  const firstTool =
    scheduleIntent &&
    tools.some((t) => t.function.name === 'get_group_schedule')
      ? 'get_group_schedule'
      : tools.some((t) => t.function.name === 'search_docs')
        ? 'search_docs'
        : 'search_kfu';
  const sources = new Map();
  const sourceUrls = new Set();
  let totalCalls = 0;
  for (let turn = 0; turn < 6; turn++) {
    signal.throwIfAborted();
    const last = turn === 5 || totalCalls >= maxToolCalls;
    emit({
      type: 'status',
      message:
        turn === 0
          ? 'Выбираю способ поиска…'
          : last
            ? 'Составляю ответ по найденным данным…'
            : 'Сопоставляю источники…',
    });
    const msg = await complete({
      key,
      model,
      messages,
      tools,
      toolChoice: last
        ? 'none'
        : turn === 0
          ? { type: 'function', function: { name: firstTool } }
          : 'auto',
      signal,
    });
    messages.push(msg);
    if (!msg.tool_calls?.length) {
      const checked = await ask({
        messages: messages.slice(0, -1),
        initialMessage: msg,
        successfulTools: [...successfulTools],
        validatePublic: (text) =>
          validatePublicAnswer(text, system, sourceUrls),
        signal,
        complete: (args) => complete({ key, model, tools, ...args }),
        onAttempt: (attempt) => {
          if (!attempt.valid)
            emit({ type: 'status', message: 'Проверяю формат ответа…' });
        },
      });
      emit({
        type: 'answer',
        content: checked.answer.answer,
        structured: checked.answer,
        validation: { attempts: checked.attempts, fallback: checked.fallback },
        sources: [...sources.values()],
      });
      return;
    }
    for (const call of msg.tool_calls) {
      signal.throwIfAborted();
      totalCalls++;
      let args = {},
        data = {},
        failed = false;
      let authorized = false;
      const name = call.function.name;
      try {
        if (totalCalls > maxToolCalls || last)
          throw new Error(
            'Достигнут лимит инструментов. Сформулируй ответ по уже полученным данным.',
          );
        if (!tools.some((t) => t.function.name === name))
          throw new Error('Неизвестный инструмент.');
        args = authorizeAgentTool(
          name,
          JSON.parse(call.function.arguments || '{}'),
          role,
        );
        authorized = true;
        await audit({
          tool: name,
          decision: 'allow',
          channel: 'agent',
          count: totalCalls,
          args,
        });
        emit({
          type: 'status',
          message:
            call.function.name === 'get_group_schedule'
              ? 'Читаю расписание группы из Google Sheets…'
              : name === 'search_docs'
                ? 'Ищу по текстовым документам ИТИС…'
                : call.function.name === 'search_kfu'
                  ? 'Ищу на официальных страницах КФУ…'
                  : 'Читаю найденную страницу…',
        });
        const result = await mcp.client.callTool(
          { name: call.function.name, arguments: args },
          undefined,
          { timeout: 120000, signal },
        );
        data = JSON.parse(
          result.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n'),
        );
        failed = !!result.isError;
        if (
          !failed &&
          (data.results?.length || data.text?.trim() || data.lessons?.length)
        )
          successfulTools.add(call.function.name);
        if (!failed && name !== 'get_group_schedule')
          for (const link of data.links || []) {
            try {
              sourceUrls.add(safeUrl(link.url));
            } catch {
              /* Ignore non-KFU links. */
            }
          }
        if (!failed)
          for (const p of data.results || (data.url ? [data] : [])) {
            let url = p.url;
            if (name !== 'get_group_schedule') {
              try {
                url = safeUrl(p.url);
              } catch {
                continue;
              }
              sourceUrls.add(url);
            }
            sources.set(url, {
              url,
              title: p.title,
              fetchedAt: p.fetchedAt,
              version: p.version,
            });
          }
      } catch (e) {
        if (!authorized)
          await audit({
            tool: name,
            decision: 'deny',
            channel: 'agent',
            count: totalCalls,
          });
        failed = true;
        data = { error: e.message };
      }
      emit({
        type: 'tool',
        step: {
          name: isAgentTool(name) ? name : 'unknown',
          arguments: args,
          status: failed ? 'error' : 'done',
          detail: failed
            ? data.error
            : data.lessons
              ? `${data.lessons.length} занятий · группа ${data.group}`
              : data.results
                ? data.results.length + ' результатов'
                : `${data.text?.length || 0} символов прочитано`,
        },
      });
      emit({ type: 'sources', sources: [...sources.values()] });
      if (
        !failed &&
        data.formattedAnswer &&
        call.function.name === 'get_group_schedule'
      ) {
        emit({
          type: 'answer',
          content: data.formattedAnswer,
          schedule: data,
          sources: [...sources.values()],
        });
        return;
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: untrustedObservation(
          data,
          name === 'search_docs' ? 'doc' : 'tool',
        ),
      });
    }
  }
  throw new Error(
    'Достигнут лимит шагов. Попробуй задать более конкретный вопрос.',
  );
}
