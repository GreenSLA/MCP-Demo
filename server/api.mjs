import http from 'node:http';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { connectMcp, runAgent } from './agent.mjs';
import { createStore } from './db.mjs';
import { documentsViaMcp } from './documents.mjs';
import {
  describeFact,
  isNo,
  isYes,
  modelHistory,
  requestedMemory,
} from './memory.mjs';
import { scheduleRequest, scheduleViaMcp } from './schedule-request.mjs';
import {
  auditLocalTool,
  createRequestLimiter,
  roleAllowsTool,
  stripPromptOverrides,
} from './security.mjs';

const envFile =
  process.env.ITIS_ENV_FILE || new URL('../.env', import.meta.url);
const allowedModels = [
  'google/gemini-2.5-flash',
  'openai/gpt-4o-mini',
  'openrouter/free',
];
const port = Number(process.env.ITIS_API_PORT || 8788);
const allowedHosts = new Set(
  [port, 3000].flatMap((p) => ['127.0.0.1:' + p, 'localhost:' + p]),
);
const allowedOrigins = new Set(
  [...allowedHosts].map((host) => 'http://' + host),
);
const cookieName = 'itis_session';
const active = new Set();
const limits = new Map();
const allowAuth = createRequestLimiter(60);
const store = createStore();
await store.init();
await store.cleanup();
const cleanTimer = setInterval(() => {
  for (const [id, entry] of limits)
    if (entry.used < Date.now() - 60_000) limits.delete(id);
  void store
    .cleanup()
    .catch(() => console.error('Не удалось очистить истёкшие записи.'));
}, 60_000);
cleanTimer.unref();
let mcp;
const scheduleTool = 'get_group_schedule';

export async function config() {
  let local = {};
  try {
    local = parseEnv(await readFile(envFile, 'utf8'));
  } catch {}
  return {
    local,
    key: local.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '',
    model:
      local.OPENROUTER_MODEL ||
      process.env.OPENROUTER_MODEL ||
      allowedModels[0],
  };
}
function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}
const fail = (res, status, error) => send(res, status, { error });
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new RequestError(415, 'Требуется JSON.');
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 40000)
      throw new RequestError(413, 'Запрос слишком большой.');
  }
  try {
    const data = JSON.parse(s);
    if (!data || Array.isArray(data) || typeof data !== 'object')
      throw new Error();
    return data;
  } catch {
    throw new RequestError(400, 'Некорректный JSON.');
  }
}
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function cookie(req) {
  return req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(cookieName + '='))
    ?.slice(cookieName.length + 1);
}
function setCookie(res, token = '') {
  res.setHeader(
    'Set-Cookie',
    cookieName +
      '=' +
      token +
      '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' +
      (token ? 2592000 : 0),
  );
}
function limit(id) {
  const entry = limits.get(id) || {
    allow: createRequestLimiter(20),
    used: 0,
    denials: [],
    blockedUntil: 0,
  };
  entry.used = Date.now();
  limits.set(id, entry);
  return entry.blockedUntil <= Date.now() && entry.allow();
}
async function audit({
  tool,
  decision,
  channel,
  count = 1,
  user,
  args,
  reason,
}) {
  await auditLocalTool({ tool, decision, channel, count, user, args, reason });
  if (decision !== 'deny' || channel === 'manual-refresh' || !user) return;
  const now = Date.now();
  const entry = limits.get(user.id) || {
    allow: createRequestLimiter(20),
    used: now,
    denials: [],
    blockedUntil: 0,
  };
  entry.denials = entry.denials.filter((time) => time > now - 60_000);
  entry.denials.push(now);
  entry.used = now;
  limits.set(user.id, entry);
  if (entry.denials.length >= 3 && entry.blockedUntil <= now) {
    entry.blockedUntil = now + 60_000;
    await auditLocalTool({
      tool,
      decision: 'deny',
      channel: 'security-alert',
      count: entry.denials.length,
      user,
      reason: 'repeated-denials',
    });
  }
}

async function signIn(req, res, path, token) {
  if (!allowAuth()) return fail(res, 429, 'Слишком много попыток входа.');
  const { username, password } = await body(req);
  const name =
    typeof username === 'string' ? username.trim().toLowerCase() : '';
  if (
    !/^[a-z0-9_.-]{3,32}$/.test(name) ||
    typeof password !== 'string' ||
    !password.length ||
    password.length > 128 ||
    password.includes('\0')
  )
    return fail(
      res,
      400,
      'Логин должен состоять из 3–32 латинских букв, цифр, точек, дефисов или подчёркиваний. Введи пароль.',
    );
  const register = path === '/api/register';
  const user = await (register
    ? store.register(name, password)
    : store.login(name, password));
  if (!user)
    return fail(
      res,
      register ? 409 : 401,
      register ? 'Логин уже занят.' : 'Неверный логин или пароль.',
    );
  if (token) await store.logout(token);
  setCookie(res, await store.issueToken(user.id));
  return send(res, register ? 201 : 200, { user });
}

async function saveConfig(req, res) {
  const { key, model } = await body(req);
  const current = await config();
  if (
    typeof key !== 'string' ||
    (key && !/^sk-or-[a-zA-Z0-9_-]{15,}$/.test(key))
  )
    return fail(
      res,
      400,
      'Ключ должен начинаться с sk-or- и не содержать пробелов.',
    );
  if (!allowedModels.includes(model))
    return fail(res, 400, 'Выбери модель из списка.');
  if (!key && !current.key)
    return fail(res, 400, 'Вставь API-ключ OpenRouter.');
  const existing = await readFile(envFile, 'utf8').catch(() => '');
  const lines = existing
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*(?:export\s+)?OPENROUTER_(?:API_KEY|MODEL)\s*=/.test(line),
    );
  await writeFile(
    envFile,
    lines.join('\n').trimEnd() +
      '\nOPENROUTER_API_KEY=' +
      (key || current.key) +
      '\nOPENROUTER_MODEL=' +
      model +
      '\n',
    { mode: 0o600 },
  );
  await chmod(envFile, 0o600);
  return send(res, 200, { ok: true });
}

async function schedule(req, res, user, url) {
  if (!mcp) return fail(res, 503, 'MCP-сервер ещё запускается.');
  const isPost = req.method === 'POST';
  const data = isPost ? await body(req) : Object.fromEntries(url.searchParams);
  const group = typeof data.group === 'string' ? data.group.slice(0, 40) : '';
  const day = typeof data.day === 'string' ? data.day.slice(0, 40) : '';
  const { sessionId, messageId } = data;
  if (isPost && (sessionId !== undefined || messageId !== undefined)) {
    const session = await store.session(user.id, sessionId);
    if (
      !session ||
      typeof messageId !== 'string' ||
      !/^\d{1,18}$/.test(messageId)
    )
      return fail(res, 404, 'Диалог или карточка не найдены.');
    const messages = await store.history(user.id, sessionId);
    if (
      !messages.some((message) => message.id === messageId && message.schedule)
    )
      return fail(res, 404, 'Диалог или карточка не найдены.');
  }
  const wantsRefresh = isPost && data.refresh === true;
  const refresh = wantsRefresh && (await store.reserveRefresh(user.id));
  const limited = wantsRefresh && !refresh;
  if (limited)
    await audit({
      tool: scheduleTool,
      decision: 'deny',
      channel: 'manual-refresh',
      count: 0,
      user,
      args: { group, refresh: true },
      reason: 'daily-limit',
    });
  await audit({
    tool: scheduleTool,
    decision: 'allow',
    channel: refresh ? 'manual-refresh' : 'schedule',
    user,
    args: { group, day, refresh },
  });
  const result = await scheduleViaMcp(
    mcp,
    { group, day, refresh, ...(limited ? { cacheOnly: true } : {}) },
    () => {},
  );
  if (isPost && sessionId && messageId)
    await store.updateSchedule(user.id, sessionId, messageId, result);
  return send(res, 200, { ...result, manualRefreshLimited: limited });
}

function textOnly(text) {
  return stripPromptOverrides(text)
    .replace(/https?:\/\/[^\s<>]+/giu, '')
    .replace(/[<>\[\]!*_`]/g, '')
    .trim();
}
async function quoteDocuments(
  question,
  signal,
  emit,
  user,
  tool = 'search_docs',
) {
  await audit({
    tool,
    decision: 'allow',
    channel: 'chat',
    user,
    args: { query: question },
  });
  const results = await documentsViaMcp(mcp, question, signal, tool);
  const sources = results.map(({ title, url, version }) => ({
    title,
    url,
    version,
  }));
  emit({
    type: 'tool',
    step: {
      name: tool,
      arguments: { query: question },
      status: 'done',
      detail: results.length + ' результатов',
    },
  });
  const quotes = results.map(
    (item, index) =>
      textOnly(item.excerpt) +
      '\n\n[' +
      (index + 1) +
      '. ' +
      textOnly(item.title) +
      '](' +
      item.url +
      ')',
  );
  emit({
    type: 'answer',
    content: quotes.length
      ? 'Из документов ИТИС:\n\n' + quotes.join('\n\n')
      : 'В доступных документах ИТИС не нашлось ответа. Подключи OpenRouter в настройках, чтобы бот мог поискать и на сайте КФУ.',
    sources,
  });
}

async function chat(req, res, user) {
  const data = await body(req);
  const { sessionId, confirmationId } = data;
  const question =
    typeof data.question === 'string' ? data.question.trim() : '';
  if (
    !question ||
    question.length > 9000 ||
    Object.keys(data).some(
      (key) => !['sessionId', 'question', 'confirmationId'].includes(key),
    )
  )
    return fail(res, 400, 'Отправь идентификатор диалога и вопрос.');
  if (active.has(user.id))
    return fail(res, 429, 'Дождись завершения предыдущего запроса.');
  active.add(user.id);
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  let ping;
  try {
    const session = await store.session(user.id, sessionId);
    if (!session) {
      await audit({
        tool: 'history',
        decision: 'deny',
        channel: 'chat',
        user,
        reason: 'conversation-not-found',
      });
      return fail(res, 404, 'Диалог не найден.');
    }
    const old = await store.history(user.id, sessionId);
    const history = [
      ...old.map((entry) => ({
        role: entry.role,
        content: entry.schedule?.group
          ? 'Расписание группы ' + entry.schedule.group
          : entry.content,
      })),
      { role: 'user', content: question },
    ];
    const proposal = requestedMemory(question);
    const yes = isYes(question),
      no = isNo(question);
    const facts = await store.facts(user.id);
    const timetable =
      proposal || yes || no
        ? null
        : scheduleRequest(
            history,
            facts.find(({ key }) => key === 'group')?.value,
          );
    const deadlines =
      /^(?:сроки преподавателя|вызови (?:инструмент )?deadlines)(?=$|[\s.,!?])/iu.test(
        question,
      );
    if (deadlines && !roleAllowsTool(user.role, 'deadlines')) {
      await audit({
        tool: 'deadlines',
        decision: 'deny',
        channel: 'chat',
        user,
        args: { query: question },
        reason: 'role',
      });
      return fail(res, 403, 'Нет доступа к инструменту.');
    }
    if (!mcp && ((!proposal && !yes && !no) || proposal?.key === 'group'))
      return fail(
        res,
        503,
        'MCP-сервер ещё запускается. Повтори через несколько секунд.',
      );
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    const emit = (event) => {
      if (!res.destroyed) res.write(JSON.stringify(event) + '\n');
    };
    ping = setInterval(() => emit({ type: 'ping' }), 12000);
    const userMessageId = await store.addMessage(user.id, sessionId, {
      role: 'user',
      content: question,
    });
    emit({ type: 'question', id: userMessageId });
    let answer;
    const collect = (event) => {
      if (event.type === 'answer') answer = event;
      else emit(event);
    };
    async function propose(next) {
      const id = await store.propose(user.id, sessionId, next);
      collect({
        type: 'answer',
        content:
          next.key === 'forget'
            ? 'Удалить все твои диалоги и сохранённые сведения?'
            : 'Запомнить ' + describeFact(next.key, next.value) + '?',
        confirmationId: id,
        sources: [],
      });
    }
    if (yes) {
      const saved = await store.confirm(user.id, sessionId, confirmationId);
      if (saved?.action === 'forget') {
        const next = await store.createSession(user.id);
        const content = 'Твои диалоги и сохранённые сведения удалены.';
        const id = await store.addMessage(user.id, next.id, {
          role: 'assistant',
          content,
        });
        emit({
          type: 'reset',
          session: next,
          message: { id, role: 'assistant', content },
        });
        return;
      }
      collect({
        type: 'answer',
        content: saved
          ? 'Сохранил: ' + describeFact(saved.action, saved.value) + '.'
          : 'В этом диалоге нет действующего предложения, которое можно подтвердить.',
        sources: [],
      });
    } else {
      await store.cancel(user.id, sessionId);
      if (no)
        collect({
          type: 'answer',
          content: 'Запись не подтверждена.',
          sources: [],
        });
      else if (proposal?.key === 'group') {
        await audit({
          tool: scheduleTool,
          decision: 'allow',
          channel: 'memory',
          user,
          args: { group: proposal.value },
        });
        const schedule = await scheduleViaMcp(
          mcp,
          { group: proposal.value },
          () => {},
          controller.signal,
        );
        if (schedule.needsGroup || !schedule.group)
          collect({
            type: 'answer',
            content: 'Этой группы нет в таблице. Проверь номер.',
            sources: [],
          });
        else await propose({ ...proposal, value: schedule.group });
      } else if (proposal?.key === 'invalid') {
        collect({
          type: 'answer',
          content:
            'Могу запомнить группу из расписания, курс с 1 по 6 или учебный предмет из списка.',
          sources: [],
        });
      } else if (proposal) await propose(proposal);
      else if (timetable) {
        await audit({
          tool: scheduleTool,
          decision: 'allow',
          channel: 'chat',
          user,
          args: timetable,
        });
        await scheduleViaMcp(mcp, timetable, collect, controller.signal);
      } else {
        const { key, model } = await config();
        if (deadlines)
          await quoteDocuments(
            'сроки приема подача заявления обучение',
            controller.signal,
            collect,
            user,
            'deadlines',
          );
        else if (!key)
          await quoteDocuments(question, controller.signal, collect, user);
        else
          await runAgent({
            mcp,
            key,
            model,
            history: await modelHistory(store, user.id, session, old, question),
            memory: facts
              .map(({ key, value }) => describeFact(key, value))
              .join(', '),
            role: user.role,
            emit: collect,
            signal: controller.signal,
            audit: (entry) => audit({ ...entry, user }),
          });
      }
    }
    if (answer && !controller.signal.aborted) {
      const { type, ...message } = answer;
      const id = await store.addMessage(user.id, sessionId, {
        role: 'assistant',
        ...message,
      });
      emit({ type, id, ...message });
    }
  } catch (error) {
    if (!res.headersSent) throw error;
    if (!controller.signal.aborted)
      res.write(
        JSON.stringify({
          type: 'error',
          message: error.code ? 'Не удалось сохранить диалог.' : error.message,
        }) + '\n',
      );
  } finally {
    clearInterval(ping);
    active.delete(user.id);
    if (res.headersSent && !res.destroyed) res.end();
  }
}

const server = http.createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host))
    return fail(res, 403, 'Недопустимый Host.');
  if (req.headers.origin && !allowedOrigins.has(req.headers.origin))
    return fail(res, 403, 'Недопустимый Origin.');
  if (req.headers['sec-fetch-site'] === 'cross-site')
    return fail(res, 403, 'Недопустимый источник запроса.');
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;
  const token = cookie(req);
  try {
    if (method === 'GET' && path === '/api/status') {
      const { key, model } = await config();
      return send(res, 200, { configured: !!key, model, mcp: !!mcp });
    }
    if (method === 'POST' && ['/api/register', '/api/login'].includes(path))
      return await signIn(req, res, path, token);
    const user = await store.actor(token);
    if (!user) return fail(res, 401, 'Войди в аккаунт.');
    if (method === 'GET' && path === '/api/me') return send(res, 200, { user });
    if (method === 'POST' && path === '/api/logout') {
      await body(req);
      await store.logout(token);
      setCookie(res);
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/config')
      return await saveConfig(req, res);
    if (path === '/api/sessions') {
      if (method === 'GET')
        return send(res, 200, { sessions: await store.sessions(user.id) });
      if (method === 'POST') {
        await body(req);
        return send(res, 201, { session: await store.createSession(user.id) });
      }
    }
    const sessionPath = path.match(/^\/api\/sessions\/([^/]+)(?:\/messages)?$/);
    if (sessionPath && (method === 'GET' || method === 'DELETE')) {
      const [, id] = sessionPath;
      const session = await store.session(user.id, id);
      if (!session) {
        await audit({
          tool: 'history',
          decision: 'deny',
          channel: method === 'DELETE' ? 'delete' : 'history',
          user,
          reason: 'conversation-not-found',
        });
        return fail(res, 404, 'Диалог не найден.');
      }
      if (method === 'GET')
        return send(res, 200, {
          session: { id: session.id, title: session.title },
          messages: await store.history(user.id, id),
        });
      if (active.has(user.id))
        return fail(res, 409, 'В этом аккаунте выполняется запрос.');
      await store.deleteSession(user.id, id);
      return send(res, 200, { ok: true });
    }
    if (
      (method === 'POST' && path === '/api/chat') ||
      (['GET', 'POST'].includes(method) && path === '/api/schedule')
    ) {
      if (!limit(user.id)) {
        res.setHeader('Retry-After', '60');
        return fail(res, 429, 'Слишком много запросов за минуту.');
      }
      if (path === '/api/chat') return await chat(req, res, user);
      return await schedule(req, res, user, url);
    }
    return fail(res, 404, 'Не найдено.');
  } catch (error) {
    if (res.headersSent) return res.end();
    return fail(
      res,
      error.status || 500,
      error.status ? error.message : 'Не удалось обработать запрос.',
    );
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log('ITIS API: http://127.0.0.1:' + port),
);
try {
  mcp = await connectMcp();
  console.log(
    'MCP connected:',
    mcp.tools.map((tool) => tool.function.name).join(', '),
  );
} catch (error) {
  console.error('MCP startup failed:', error.message);
}
async function shutdown() {
  server.close();
  clearInterval(cleanTimer);
  if (mcp) await mcp.client.close();
  await store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
