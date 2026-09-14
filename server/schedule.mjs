/** Read-only adapter for the user-supplied public ITIS timetable. */
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
export const SCHEDULE_ID = '12m_Ze1NOnVvdVuSDY5bj0v4r24xLY5RhtuBxNjS26yQ';
export const SCHEDULE_URL = `https://docs.google.com/spreadsheets/d/${SCHEDULE_ID}/edit`;
const DAYS = [
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
  'воскресенье',
];
let cached;
let pending;
// ExcelJS can nest rich text inside a hyperlink's `text` property.
// String(cell.text) would stringify that object instead of its visible runs.
export function cellValueText(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value.richText))
    return value.richText.map((run) => cellValueText(run.text)).join('');
  if ('text' in value) return cellValueText(value.text);
  if ('result' in value) return cellValueText(value.result);
  if ('error' in value) return String(value.error);
  throw new Error('Неизвестный формат ячейки расписания.');
}
const text = (cell) =>
  cellValueText(cell.master.value)
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .trim();
export function normalizeGroup(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[–—−]/g, '-')
      .match(/11(?:\s*\.\s*1)?\s*-\s*\d{3}[а-яa-z]?(?![а-яa-z0-9])/)?.[0]
      ?.replace(/\s/g, '') || ''
  );
}
export function parseSchedule(workbook) {
  const sheets = [];
  for (const ws of workbook.worksheets) {
    const groups = [];
    for (let c = 1; c <= Math.min(ws.columnCount, 150); c++) {
      const label = text(ws.getCell(2, c));
      const group = normalizeGroup(label);
      if (group)
        groups.push({
          group,
          label,
          column: c,
          semester: text(ws.getCell(1, c)),
        });
    }
    if (!groups.length) continue;
    for (const g of groups) {
      const lessons = [];
      let day = '';
      const seen = new Set();
      for (let r = 3; r <= Math.min(ws.rowCount, 300); r++) {
        const label = text(ws.getCell(r, 1))
          .toLowerCase()
          .replace(/[^а-я]/g, '');
        day = DAYS.find((d) => label.includes(d)) || day;
        const time = text(ws.getCell(r, 2))
          .replace(/\s+/g, '')
          .replace(/\./g, ':')
          .replace(/[–—]/g, '-');
        if (!day || !/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(time)) continue;
        const cell = ws.getCell(r, g.column);
        const details = text(cell);
        if (!details) continue;
        const identity = day + '|' + time + '|' + cell.master.address;
        if (seen.has(identity)) continue;
        seen.add(identity);
        lessons.push({
          day,
          time,
          details,
          cell: cell.address,
          sourceCell: cell.master.address,
        });
      }
      sheets.push({ ...g, sheet: ws.name, lessons });
    }
  }
  if (!sheets.length)
    throw new Error(
      'Структура таблицы изменилась: строка с группами не найдена.',
    );
  return sheets;
}
export function resolveDay(value = '', now = new Date()) {
  const normalized = value.toLowerCase().trim();
  if (!normalized || ['вся неделя', 'неделя', 'all'].includes(normalized))
    return { day: null };
  if (['сегодня', 'завтра', 'послезавтра'].includes(normalized)) {
    const moscow = new Date(
      now.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }) +
        'T12:00:00Z',
    );
    moscow.setUTCDate(
      moscow.getUTCDate() +
        ['сегодня', 'завтра', 'послезавтра'].indexOf(normalized),
    );
    return {
      day: DAYS[(moscow.getUTCDay() + 6) % 7],
      date: moscow.toISOString().slice(0, 10),
    };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const date = new Date(normalized + 'T12:00:00Z');
    if (
      !Number.isFinite(date.valueOf()) ||
      date.toISOString().slice(0, 10) !== normalized
    )
      throw new Error('Некорректная дата.');
    return { day: DAYS[(date.getUTCDay() + 6) % 7], date: normalized };
  }
  const abbreviations = { пн: 0, вт: 1, ср: 2, чт: 3, пт: 4, сб: 5, вс: 6 };
  const day =
    DAYS.find((d) => normalized.includes(d.slice(0, 5))) ||
    (normalized in abbreviations ? DAYS[abbreviations[normalized]] : null);
  if (!day)
    throw new Error('Укажи день недели, сегодня, завтра или дату ГГГГ-ММ-ДД.');
  return { day };
}
export async function loadSchedule(refresh = false) {
  if (!refresh && !cached) {
    cached = JSON.parse(
      await readFile(new URL('./data/timetable.json', import.meta.url), 'utf8'),
    );
  }
  if (!refresh && cached?.mode === 'snapshot') return cached;
  if (!refresh && cached && Date.now() - Date.parse(cached.fetchedAt) < 120000)
    return cached;
  if (!pending)
    pending = (async () => {
      const response = await fetch(
        `https://docs.google.com/spreadsheets/d/${SCHEDULE_ID}/export?format=xlsx`,
        { signal: AbortSignal.timeout(35000) },
      );
      if (!response.ok)
        throw new Error(`Google Sheets вернул HTTP ${response.status}.`);
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 15_000_000) {
          await reader.cancel();
          throw new Error('Таблица слишком большая.');
        }
        chunks.push(value);
      }
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.concat(chunks));
      cached = {
        groups: parseSchedule(workbook),
        mode: 'live',
        fetchedAt: new Date().toISOString(),
      };
      return cached;
    })().finally(() => {
      pending = null;
    });
  return pending;
}
function plainMarkdown(value) {
  return value.replace(/[\\`*_\[\]<>#]/g, '\\$&');
}
export function scheduleResult(data, { group = '', day = '' } = {}) {
  const requested = normalizeGroup(group);
  const filter = resolveDay(day);
  const base = {
    url: SCHEDULE_URL,
    title: 'Расписание ИТИС · Google Sheets',
    fetchedAt: data.fetchedAt,
    mode: data.mode || 'snapshot',
    availableGroups: data.groups.map((g) => g.label),
  };
  if (!requested || !data.groups.some((g) => g.group === requested))
    return {
      ...base,
      needsGroup: true,
      availableGroups: data.groups.map((g) => g.label),
      formattedAnswer:
        (!group
          ? 'Напиши номер группы, например **11-401**, и при желании день недели.'
          : 'Группа **' +
            plainMarkdown(group) +
            '** не найдена в этой таблице.') +
        '\n\nДоступные группы: ' +
        data.groups.map((g) => g.label).join(', ') +
        `\n\n[Таблица расписания](${SCHEDULE_URL})`,
    };
  const matches = data.groups.filter((g) => g.group === requested);
  if (matches.length !== 1)
    throw new Error(
      'Группа встречается в нескольких разделах расписания; требуется уточнение источника.',
    );
  const match = matches[0];
  const lessons = match.lessons.filter(
    (l) => !filter.day || l.day === filter.day,
  );
  const warnings = [
    ...(data.mode !== 'live'
      ? [
          'Показана сохранённая копия расписания. Дата получения указана рядом с источником; изменения после этой даты в неё не включены.',
        ]
      : []),
    'Пометки о неделях, датах, подгруппах и дисциплинах по выбору сохранены из таблицы. Применимость к конкретной учебной неделе автоматически не определяется.',
  ];
  if (filter.date)
    warnings.push(
      `Для ${filter.date} показан шаблон соответствующего дня недели, а не подтверждённое расписание на дату: учти каникулы, отмены и условия в ячейках.`,
    );
  let answer = `## Расписание группы ${match.label}\n\n${plainMarkdown(match.semester).replace(/\n/g, ' ')}\n\n`;
  for (const d of filter.day ? [filter.day] : DAYS.slice(0, 6)) {
    answer += `### ${d[0].toUpperCase() + d.slice(1)}${filter.date ? ' · ' + filter.date : ''}\n\n`;
    const items = lessons.filter((l) => l.day === d);
    if (!items.length)
      answer += 'В таблице на этот день нет записей для группы.\n\n';
    for (const item of items)
      answer += `**${item.time}**\n\n${plainMarkdown(item.details).replace(/\n/g, '  \n')}\n\n`;
  }
  answer +=
    warnings.map((w) => `> ${w}`).join('\n\n') +
    `\n\n[Источник: таблица расписания ИТИС](${SCHEDULE_URL}) · получено ${new Date(data.fetchedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (МСК).`;
  return {
    ...base,
    group: match.group,
    sheet: match.sheet,
    semester: match.semester,
    day: filter.day,
    date: filter.date,
    lessons,
    weekLessons: match.lessons,
    warnings,
    formattedAnswer: answer,
  };
}
export async function getGroupSchedule(args) {
  return scheduleResult(await loadSchedule(args.refresh), args);
}
