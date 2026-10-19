import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const AnswerSchema = z
  .object({
    answer: z.string().trim().min(1).max(4000),
    source_tool: z
      .enum(['search_kfu', 'read_kfu_page', 'get_group_schedule'])
      .nullable(),
    found: z.boolean(),
  })
  .strict();

export const answerResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'university_answer',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['answer', 'source_tool', 'found'],
      properties: {
        answer: { type: 'string' },
        source_tool: {
          type: ['string', 'null'],
          enum: ['search_kfu', 'read_kfu_page', 'get_group_schedule', null],
        },
        found: { type: 'boolean' },
      },
    },
  },
};

export function loadPrompts(version = 'v1', { fewshot = true, today } = {}) {
  if (!['v0', 'v1'].includes(version))
    throw new Error('Unknown prompt version');
  const date =
    today ||
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  const system = readFileSync(
    new URL(`../prompts/system_${version}.md`, import.meta.url),
    'utf8',
  ).replaceAll('{{TODAY}}', date);
  const examples =
    version === 'v1' && fewshot
      ? JSON.parse(
          readFileSync(
            new URL('../prompts/fewshot_v1.json', import.meta.url),
            'utf8',
          ),
        )
      : [];
  return { system, examples };
}

// Remove URLs so years and numbers inside source links do not count as a stated date.
export function containsDate(text) {
  const prose = text.replace(/https?:\/\/[^\s)]+/g, '');
  return /\b\d{1,2}[.:/]\d{2}(?:[./]\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:19|20)\d{2}\b|\d{1,2}\s*(?:январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)|сегодня|завтра|послезавтра|понедельник|вторник|сред[ауеы]|четверг|пятниц|суббот|воскресень/iu.test(
    prose,
  );
}

export function validateAnswer(text, { successfulTools = [] } = {}) {
  const value = AnswerSchema.parse(JSON.parse(text));
  if (!value.found && containsDate(value.answer))
    throw new Error('found=false: запрещены конкретные даты и время');
  if (!value.found && value.source_tool !== null)
    throw new Error('found=false: source_tool должен быть null');
  if (
    value.found &&
    (!value.source_tool || !successfulTools.includes(value.source_tool))
  )
    throw new Error('found=true требует успешный источник текущего запроса');
  return value;
}

export const fallbackAnswer = () => ({
  answer:
    'Не удалось получить проверенный ответ. Уточните вопрос или обратитесь в учебный офис.',
  source_tool: null,
  found: false,
});

/** Validate the first response, make at most one correction request, then use a safe object. */
export async function ask({
  messages,
  complete,
  initialMessage,
  successfulTools = [],
  onAttempt = () => {},
  signal,
}) {
  const conversation = [...messages];
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const msg =
      attempt === 0 && initialMessage
        ? initialMessage
        : await complete({
            messages: conversation,
            toolChoice: 'none',
            responseFormat: answerResponseFormat,
            signal,
          });
    try {
      const answer = validateAnswer(msg.content, { successfulTools });
      onAttempt({ attempt, valid: true, raw: msg.content });
      return { answer, attempts: attempt + 1, fallback: false };
    } catch (e) {
      onAttempt({ attempt, valid: false, raw: msg.content, error: e.message });
      if (attempt === 0)
        conversation.push(
          { role: 'assistant', content: msg.content || '' },
          {
            role: 'user',
            content: `Исправь только формат/проверяемое условие предыдущего ответа. Ошибка проверки: ${e.message}. Верни JSON с answer, source_tool, found. Новых фактов не добавляй. Если подтверждения нет, found=false, source_tool=null и никаких дат или времени.`,
          },
        );
    }
  }
  return { answer: fallbackAnswer(), attempts: 2, fallback: true };
}
