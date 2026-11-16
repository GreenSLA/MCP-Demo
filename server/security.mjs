import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { safeUrl } from './knowledge.mjs';

const readOnlyTools = new Map([
  [
    'search_docs',
    z.strictObject({
      query: z.string().trim().min(2).max(500),
      limit: z.number().int().min(1).max(6).optional(),
    }),
  ],
  ['deadlines', z.strictObject({ query: z.string().trim().min(2).max(500) })],
  [
    'search_kfu',
    z.strictObject({
      query: z.string().trim().min(2).max(500),
      limit: z.number().int().min(1).max(6).optional(),
    }),
  ],
  [
    'read_kfu_page',
    z.strictObject({
      url: z.string().url().transform(safeUrl),
      refresh: z.literal(false).optional(),
    }),
  ],
  [
    'get_group_schedule',
    z.strictObject({
      group: z.string().max(40).optional(),
      day: z.string().max(40).optional(),
      refresh: z.literal(false).optional(),
    }),
  ],
]);

export function isAgentTool(name) {
  return readOnlyTools.has(name);
}
export function roleAllowsTool(role, name) {
  return (
    isAgentTool(name) &&
    (name === 'deadlines'
      ? role === 'teacher'
      : ['student', 'teacher'].includes(role))
  );
}

export function authorizeAgentTool(name, args, role = 'student') {
  const schema = readOnlyTools.get(name);
  if (!schema || !roleAllowsTool(role, name))
    throw new Error('Нет доступа к инструменту.');
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    // Identity is supplied by the authenticated request, never by a tool argument.
    const fields = { ...args };
    delete fields.user_id;
    delete fields.userId;
    args = fields;
  }
  try {
    return schema.parse(args);
  } catch {
    throw new Error('Аргументы не разрешены для этого инструмента.');
  }
}

// Only recognizable overrides are stripped. All remaining external text is still untrusted.
const override =
  /^(?:\[\s*\/?)?(?:system|developer|assistant)\s*(?:[:：]|\])|^(?:ignore|disregard)\s+(?:all\s+)?(?:(?:the|any)\s+)?(?:previous|prior|above)\s+(?:instructions|rules)\b|^(?:игнорируй|забудь|отмени)\s+(?:(?:все|любые)\s+)?(?:предыдущ\p{L}*\s+)?(?:правила|инструкции|промпт)(?!\p{L})/iu;

export function stripPromptOverrides(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !override.test(line.trim().normalize('NFKC')))
    .join('\n');
}

export function untrustedObservation(data, tag = 'tool') {
  function clean(value) {
    if (typeof value === 'string') return stripPromptOverrides(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, clean(child)]),
      );
    return value;
  }

  const value = JSON.stringify(clean(data)).replace(
    /[<>&]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  return '<' + tag + '>' + value + '</' + tag + '>';
}

function normalized(text) {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function validatePublicAnswer(answer, prompt, sourceUrls) {
  const text = normalized(answer);
  const privateSentences = prompt
    .split(/(?<=[.!?])\s+|\r?\n/)
    .map(normalized)
    .filter((sentence) => sentence.length >= 85);
  if (
    privateSentences.some((sentence) =>
      text.includes(sentence.replace(/[.!?]$/, '')),
    )
  )
    throw new Error('Ответ содержит закрытые инструкции.');

  for (const match of answer.matchAll(/\bhttps?:\/\/[^\s()[\]<>"']+/giu)) {
    let url;
    try {
      url = safeUrl(match[0].replace(/[.,;!?]+$/, ''));
    } catch {
      throw new Error('В ответе есть ссылка вне источников ИТИС.');
    }
    if (!sourceUrls.has(url))
      throw new Error('В ответе есть непроверенная ссылка.');
  }
}

export function createRequestLimiter(maxRequests = 40, windowMs = 60_000) {
  const times = [];
  return (now = Date.now()) => {
    while (times.length && times[0] <= now - windowMs) times.shift();
    if (times.length >= maxRequests) return false;
    times.push(now);
    return true;
  };
}

const auditDirectory = new URL('../data/', import.meta.url);
let auditFailureReported = false;

export async function auditLocalTool({
  tool,
  decision,
  channel,
  count,
  user,
  args = {},
  reason,
}) {
  const masked = Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === 'boolean' && ['refresh', 'cacheOnly'].includes(key)
        ? value
        : '[скрыто]',
    ]),
  );
  const entry = {
    timestamp: new Date().toISOString(),
    user_id: user?.id,
    role: user?.role,
    channel,
    tool: isAgentTool(tool) ? tool : 'unknown',
    decision,
    count,
    args: masked,
    reason,
  };
  try {
    const target =
      process.env.ITIS_AUDIT_FILE || new URL('audit.jsonl', auditDirectory);
    await mkdir(typeof target === 'string' ? dirname(target) : auditDirectory, {
      recursive: true,
    });
    await appendFile(target, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    if (!auditFailureReported)
      console.error('Не удалось записать локальный аудит MCP.');
    auditFailureReported = true;
  }
}
