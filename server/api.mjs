import http from 'node:http';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { connectMcp, runAgent } from './agent.mjs';
import { scheduleRequest, scheduleViaMcp } from './schedule-request.mjs';
const envFile = new URL('../.env', import.meta.url);
const allowedModels = [
  'google/gemini-2.5-flash',
  'openai/gpt-4o-mini',
  'openrouter/free',
];
export async function config() {
  let local = {};
  try {
    local = parseEnv(await readFile(envFile, 'utf8'));
  } catch {}
  return {
    key: local.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '',
    model:
      local.OPENROUTER_MODEL ||
      process.env.OPENROUTER_MODEL ||
      allowedModels[0],
  };
}
let mcp;
let active = false;
const send = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
};
async function body(req) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 40000) throw new Error('Запрос слишком большой.');
  }
  return JSON.parse(s);
}
const server = http.createServer(async (req, res) => {
  // Loopback binding plus Origin/Host checks protect the local key settings.
  if (
    ![
      '127.0.0.1:8788',
      'localhost:8788',
      'localhost:3000',
      '127.0.0.1:3000',
    ].includes(req.headers.host)
  )
    return send(res, 403, { error: 'Недопустимый Host.' });
  const origin = req.headers.origin;
  if (
    origin &&
    !['http://localhost:3000', 'http://127.0.0.1:3000'].includes(origin)
  )
    return send(res, 403, { error: 'Недопустимый Origin.' });
  try {
    if (req.method === 'GET' && req.url === '/api/status') {
      const c = await config();
      return send(res, 200, {
        configured: !!c.key,
        model: c.model,
        mcp: !!mcp,
        pages: 0,
      });
    }
    if (req.method === 'POST' && req.url === '/api/config') {
      if (!req.headers['content-type']?.startsWith('application/json'))
        return send(res, 415, { error: 'Требуется JSON.' });
      const { key, model } = await body(req);
      const current = await config();
      if (
        typeof key !== 'string' ||
        (key && !/^sk-or-[a-zA-Z0-9_-]{15,}$/.test(key))
      )
        return send(res, 400, {
          error: 'Ключ должен начинаться с sk-or- и не содержать пробелов.',
        });
      if (!allowedModels.includes(model))
        return send(res, 400, { error: 'Выбери модель из списка.' });
      if (!key && !current.key)
        return send(res, 400, { error: 'Вставь API-ключ OpenRouter.' });
      await writeFile(
        envFile,
        `OPENROUTER_API_KEY=${key || current.key}\nOPENROUTER_MODEL=${model}\n`,
        { mode: 0o600 },
      );
      await chmod(envFile, 0o600);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/schedule?')) {
      if (!mcp) return send(res, 503, { error: 'MCP-сервер ещё запускается.' });
      const params = new URL(req.url, 'http://localhost').searchParams;
      try {
        const data = await scheduleViaMcp(
          mcp,
          {
            group: (params.get('group') || '').slice(0, 40),
            day: (params.get('day') || '').slice(0, 40),
            refresh: params.get('refresh') === 'true',
          },
          () => {},
        );
        return send(res, 200, data);
      } catch (e) {
        return send(res, 502, { error: e.message });
      }
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      const c = await config();
      if (!mcp)
        return send(res, 503, {
          error: 'MCP-сервер ещё запускается. Повтори через несколько секунд.',
        });
      if (active)
        return send(res, 429, {
          error: 'Дождись завершения предыдущего запроса.',
        });
      const { messages } = await body(req);
      if (
        !Array.isArray(messages) ||
        !messages.length ||
        messages.length > 40 ||
        messages.some(
          (m) =>
            !['user', 'assistant'].includes(m.role) ||
            typeof m.content !== 'string' ||
            m.content.length > 10000,
        ) ||
        messages.at(-1).role !== 'user'
      )
        return send(res, 400, {
          error: 'Некорректная история диалога. Начни новый диалог.',
        });
      const timetable = scheduleRequest(messages);
      if (!timetable && !c.key)
        return send(res, 400, {
          error:
            'Для ответов на общие вопросы подключи OpenRouter в настройках. Расписание доступно без ключа.',
        });
      active = true;
      const controller = new AbortController();
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      const emit = (e) => {
        if (!res.destroyed) res.write(JSON.stringify(e) + '\n');
      };
      res.on('close', () => controller.abort());
      const ping = setInterval(() => emit({ type: 'ping' }), 12000);
      try {
        if (timetable) await scheduleViaMcp(mcp, timetable, emit);
        else
          await runAgent({
            mcp,
            ...c,
            history: messages
              .slice(-16)
              .map(({ role, content }) => ({ role, content })),
            emit,
            signal: controller.signal,
          });
      } catch (e) {
        if (!controller.signal.aborted)
          emit({ type: 'error', message: e.message });
      } finally {
        clearInterval(ping);
        active = false;
        res.end();
      }
      return;
    }
    return send(res, 404, { error: 'Не найдено.' });
  } catch {
    if (!res.headersSent)
      send(res, 400, {
        error: 'Не удалось обработать запрос. Проверь введённые данные.',
      });
    else res.end();
  }
});
server.listen(8788, '127.0.0.1', () =>
  console.log('ITIS API: http://127.0.0.1:8788'),
);
try {
  mcp = await connectMcp();
  console.log(
    'MCP connected:',
    mcp.tools.map((t) => t.function.name).join(', '),
  );
} catch (e) {
  console.error('MCP startup failed:', e.message);
}
async function shutdown() {
  server.close();
  if (mcp) await mcp.client.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
