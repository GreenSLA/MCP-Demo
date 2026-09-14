import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  parseSchedule,
  normalizeGroup,
  resolveDay,
  scheduleResult,
} from '../server/schedule.mjs';
function fixture() {
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet('Расписание');
  s.mergeCells('A1:B2');
  s.mergeCells('C1:D1');
  s.getCell('C1').value = '3 курс, 2026 / 2027';
  s.getCell('C2').value = '11-401';
  s.getCell('D2').value = '11-402';
  s.mergeCells('A3:A5');
  s.getCell('A3').value = '* П О Н Е Д Е Л Ь Н И К *';
  s.getCell('B3').value = '08.30-\n10.00';
  s.getCell('B4').value = '10.10-\n11.40';
  s.getCell('B5').value = '12.10-\n13.40';
  s.mergeCells('C3:D3');
  s.getCell('C3').value = 'Общая лекция\nИванов И.И.\n1306\nнечетн. нед.';
  s.getCell('C4').value = 'Практика группы 401\n1307';
  s.getCell('D5').value = 'Практика группы 402\nподгр. 2\n1308';
  return parseSchedule(w);
}
test('merged lectures belong to every covered group, separate practices do not leak', () => {
  const groups = fixture();
  const a = groups.find((g) => g.group === '11-401');
  const b = groups.find((g) => g.group === '11-402');
  assert.equal(a.lessons.length, 2);
  assert.equal(b.lessons.length, 2);
  assert.equal(b.lessons[0].sourceCell, 'C3');
  assert.equal(b.lessons[0].time, '08:30-10:00');
  assert.match(b.lessons[0].details, /нечетн/);
  assert.ok(!b.lessons.some((l) => l.details.includes('401')));
  assert.equal(b.semester, '3 курс, 2026 / 2027');
});
test('group matching is exact and understands masters and suffixes', () => {
  assert.equal(normalizeGroup('11 — 401'), '11-401');
  assert.equal(normalizeGroup('11.1-621'), '11.1-621');
  assert.equal(normalizeGroup('11-413а'), '11-413а');
  const r = scheduleResult(
    { groups: fixture(), fetchedAt: new Date().toISOString() },
    { group: '11-499' },
  );
  assert.equal(r.needsGroup, true);
  assert.ok(!r.lessons);
});
test('relative dates use Moscow and invalid calendar dates are rejected', () => {
  assert.deepEqual(resolveDay('завтра', new Date('2026-09-07T22:00:00Z')), {
    day: 'среда',
    date: '2026-09-09',
  });
  assert.throws(() => resolveDay('2026-02-30'));
  assert.equal(resolveDay('в понедельник').day, 'понедельник');
});
test('format preserves full cell conditions, filters day and does not fabricate Sunday lessons', () => {
  const data = { groups: fixture(), fetchedAt: new Date().toISOString() };
  const r = scheduleResult(data, { group: '11-402', day: 'понедельник' });
  assert.match(r.formattedAnswer, /нечетн/);
  assert.match(r.formattedAnswer, /подгр\. 2/);
  assert.equal(r.lessons.length, 2);
  assert.equal(
    scheduleResult(data, { group: '11-402', day: 'воскресенье' }).lessons
      .length,
    0,
  );
});

test('hyperlinks containing nested rich text preserve subjects, teachers and conditions', async () => {
  const { cellValueText } = await import('../server/schedule.mjs');
  const value = {
    text: {
      richText: [
        { text: 'Дисциплина по выбору:\n' },
        { font: { bold: true }, text: 'Функциональное программирование\n' },
        { text: 'Преподаватель И.И.\n1305\nс 14 сентября' },
      ],
    },
    hyperlink: 'https://example.org/lesson',
  };
  assert.equal(
    cellValueText(value),
    'Дисциплина по выбору:\nФункциональное программирование\nПреподаватель И.И.\n1305\nс 14 сентября',
  );
  assert.equal(
    cellValueText({
      formula: 'A1',
      result: { richText: [{ text: 'Лекция' }] },
    }),
    'Лекция',
  );
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Расписание');
  sheet.getCell('C2').value = '11-401';
  sheet.getCell('D2').value = '11-402';
  sheet.getCell('A3').value = 'ПОНЕДЕЛЬНИК';
  sheet.getCell('B3').value = '08.30-10.00';
  sheet.mergeCells('C3:D3');
  sheet.getCell('C3').value = value;
  for (const group of parseSchedule(workbook))
    assert.equal(group.lessons[0].details, cellValueText(value));
});

test('bundled timetable contains no object stringification artifacts', async () => {
  const { readFile } = await import('node:fs/promises');
  const data = JSON.parse(
    await readFile(
      new URL('../server/data/timetable.json', import.meta.url),
      'utf8',
    ),
  );
  assert.ok(data.groups.length > 0);
  for (const group of data.groups)
    for (const lesson of group.lessons)
      assert.ok(
        !lesson.details.includes('[object Object]'),
        `${group.group} ${lesson.cell}`,
      );
});
