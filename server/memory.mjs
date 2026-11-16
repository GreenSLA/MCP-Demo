import { getEncoding } from 'js-tiktoken';
import { normalizeGroup } from './schedule.mjs';

const subjects = [
  ['матан', 'Математический анализ'],
  ['математическ', 'Математический анализ'],
  ['алгоритм', 'Алгоритмы и структуры данных'],
  ['аисд', 'Алгоритмы и структуры данных'],
  ['программирован', 'Программирование'],
  ['базы данных', 'Базы данных'],
  ['физик', 'Физика'],
  ['английск', 'Английский язык'],
];
const names = { group: 'группа', course: 'курс', subject: 'предмет' };
const subjectIn = (text) =>
  subjects.find(([match]) => text.toLowerCase().includes(match))?.[1];
const clean = (s) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .trim();
export const isYes = (s) =>
  /^(да|подтверждаю|согласен|согласна)$/.test(clean(s));
export const isNo = (s) => /^(нет|отмена|не надо)$/.test(clean(s));
export const describeFact = (key, value) => names[key] + ' ' + value;

export function requestedMemory(value) {
  const text = clean(value);
  if (
    /^(забудь|забудь меня|забудь всё|забудь все|удали мою память)$/.test(text)
  )
    return { key: 'forget', value: '' };
  if (
    !/^(?:запомни\b|запомни(?=\s)|моя группа|мой курс|мой предмет|я на |я учусь на )/.test(
      text,
    )
  )
    return;
  const group = normalizeGroup(text);
  if (group && /групп|^запомни\s+11/.test(text))
    return { key: 'group', value: group };
  const course = text.match(
    /(?:курс(?:е)?\s+([1-6])(?:\s|$)|(?:^|\s)([1-6])(?:-м|-й)?\s+курс(?:е)?(?=$|\s))/u,
  );
  if (course) return { key: 'course', value: course[1] || course[2] };
  const subjectText = text.replace(
    /^(?:запомни\s*:?\s*)?(?:(?:мой\s+)?предмет\s*:?\s*)?/,
    '',
  );
  const subject = subjects.find(
    ([word, name]) =>
      subjectText === word || subjectText === name.toLowerCase(),
  )?.[1];
  if (subject) return { key: 'subject', value: subject };
  return { key: 'invalid', value: '' };
}

let encoder;
const tokens = (text) =>
  (encoder ||= getEncoding('o200k_base')).encode(text, [], []).length;
function contextText(message) {
  if (message.schedule?.group)
    return 'Расписание группы ' + message.schedule.group;
  return message.content;
}
function summarize(previous, displaced) {
  const all = [{ role: 'assistant', content: previous }, ...displaced];
  const reversed = [...all].reverse();
  const group = reversed
    .map((entry) => normalizeGroup(contextText(entry)))
    .find(Boolean);
  const subject = reversed
    .filter((entry) => entry.role === 'user' || entry.content === previous)
    .map((entry) => subjectIn(contextText(entry)))
    .find(Boolean);
  const points = [
    ...(group ? ['Группа в предыдущих сообщениях: ' + group + '.'] : []),
    ...(subject ? ['Предмет разговора: ' + subject + '.'] : []),
    ...displaced
      .filter((item) => item.role === 'user')
      .slice(-2)
      .map(
        (item) =>
          'Ранее спрашивали: ' +
          item.content.replace(/\s+/g, ' ').slice(0, 120),
      ),
  ];
  return points.join('\n') || previous;
}

export async function modelHistory(store, userId, session, history, question) {
  const old = history
    .slice(0, -4)
    .filter((message) => BigInt(message.id) > BigInt(session.summary_through));
  const summary = old.length
    ? summarize(session.summary, old)
    : session.summary;
  if (old.length)
    await store.updateSummary(userId, session.id, summary, old.at(-1).id);
  const initial = summary
    ? [
        {
          role: 'assistant',
          content: 'Сводка более ранних сообщений:\n' + summary,
        },
      ]
    : [];
  let budget =
    2000 - initial.reduce((sum, entry) => sum + tokens(entry.content) + 8, 0);
  const recent = [];
  for (const m of history.slice(-4).reverse()) {
    let content = contextText(m);
    while (content && tokens(content) + 8 > budget)
      content = content.slice(0, Math.floor(content.length / 2));
    if (!content) break;
    budget -= tokens(content) + 8;
    recent.unshift({ role: m.role, content });
  }
  return [...initial, ...recent, { role: 'user', content: question }];
}
