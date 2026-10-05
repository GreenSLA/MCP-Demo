/** Offline analysis of the recorded responses; no API calls. */
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const read = async (name) =>
  (await readFile(new URL(`results/${name}.jsonl`, import.meta.url), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
const local = await read('local'),
  cloud = await read('cloud');
assert.equal(local.length, 26, 'Local experiment is incomplete');
assert.equal(cloud.filter((r) => r.experiment === 'language').length, 6);
assert.equal(cloud.filter((r) => r.experiment === 'temperature').length, 12);
for (const r of [...local, ...cloud]) {
  assert.ok(!r.error && Number.isFinite(r.input) && Number.isFinite(r.output));
  assert.equal(r.total, r.input + r.output);
}
const sum = (rs, key) => rs.reduce((s, r) => s + (r[key] || 0), 0);
const mean = (rs, key) => sum(rs, key) / rs.length;
const f = (n) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const usd = (n) => '$' + n.toFixed(7);
const table = (headers, rows) =>
  [headers, headers.map(() => '---'), ...rows]
    .map((r) => '| ' + r.join(' | ') + ' |')
    .join('\n');
const language = [];
const temperatures = [];
for (const [name, rs] of [
  ['Gemini 2.5 Flash', cloud],
  ['Qwen3.5:9b', local],
]) {
  for (const lang of ['ru', 'en']) {
    const selected = rs.filter(
      (r) => r.experiment === 'language' && r.lang === lang,
    );
    language.push({
      model: name,
      lang,
      n: selected.length,
      input: mean(selected, 'input'),
      output: mean(selected, 'output'),
      total: mean(selected, 'total'),
    });
  }
  for (const temperature of [0, 0.2, 0.8, 1.4]) {
    const selected = rs.filter(
      (r) => r.experiment === 'temperature' && r.temperature === temperature,
    );
    temperatures.push({
      model: name,
      temperature,
      n: selected.length,
      input: mean(selected, 'input'),
      output: mean(selected, 'output'),
      minOutput: Math.min(...selected.map((r) => r.output)),
      maxOutput: Math.max(...selected.map((r) => r.output)),
      unique: new Set(selected.map((r) => r.answer)).size,
      preservesFields: selected.filter((r) =>
        ['11-401', '14:00', '15:50', '1306'].every((v) => r.answer.includes(v)),
      ).length,
      lengthStops: selected.filter((r) => r.finish === 'length').length,
    });
  }
}
const context = local
  .filter((r) => r.experiment === 'context')
  .map((r) => {
    let parsed = null;
    try {
      parsed = JSON.parse(r.answer);
    } catch {}
    const expected = { begin: '714693', middle: '583027', end: '926481' };
    const correct = Object.values(expected).filter((v) =>
      r.answer.includes(v),
    ).length;
    return {
      id: r.id,
      lines: r.lines,
      numCtx: r.numCtx,
      input: r.input,
      output: r.output,
      correct,
      validJSON: !!parsed,
      answer: r.answer,
      seconds: r.seconds,
    };
  });
const app = [];
for (const session of [1, 2, 3]) {
  const rs = cloud.filter(
    (r) => r.experiment === 'app' && r.session === session,
  );
  const trace = JSON.parse(
    await readFile(
      new URL(`results/app-${session}.json`, import.meta.url),
      'utf8',
    ),
  );
  assert.ok(trace.events.some((e) => e.type === 'answer'));
  assert.ok(!trace.events.some((e) => e.type === 'error'));
  app.push({
    session,
    question: rs[0].question,
    calls: rs.length,
    input: sum(rs, 'input'),
    output: sum(rs, 'output'),
    total: sum(rs, 'total'),
    cost: sum(rs, 'cost'),
    tools: trace.events
      .filter((e) => e.type === 'tool')
      .map((e) => e.step.name),
  });
}
const average = {
  input: mean(app, 'input'),
  output: mean(app, 'output'),
  total: mean(app, 'total'),
  cost: mean(app, 'cost'),
};
const scenarios = [
  ['Редкое использование', 3, 0.8],
  ['Базовый сценарий', 5, 0.6],
  ['Активное использование', 10, 0.3],
].map(([name, questions, scheduleShare]) => ({
  name,
  questions,
  scheduleShare,
  llmQuestions: questions * (1 - scheduleShare),
  tokens: questions * (1 - scheduleShare) * average.total,
  cost: questions * (1 - scheduleShare) * average.cost,
}));
const totalCost = sum(cloud, 'cost');
const summary = {
  firstRecordedAt: local[0].at,
  requests: { local: local.length, cloud: cloud.length },
  totalCloudCostUSD: totalCost,
  language,
  temperatures,
  context,
  app,
  average,
  scenarios,
};
await writeFile(
  new URL('results/summary.json', import.meta.url),
  JSON.stringify(summary, null, 2) + '\n',
);
const measured = `# Автоматическая сводка измерений

Создано из файлов results/local.jsonl и results/cloud.jsonl. Интерпретация исходного запуска 2026-10-05 находится в REPORT.md; после новых экспериментов её нужно пересмотреть по новым ответам.

Облачных вызовов: ${cloud.length}; локальных: ${local.length}; расходы: ${usd(totalCost)}.

## Языки

${table(
  ['Модель', 'Язык', 'Вход', 'Выход', 'Всего'],
  language.map((r) => [
    r.model,
    r.lang,
    ...['input', 'output', 'total'].map((k) => f(r[k])),
  ]),
)}

## Температуры

${table(
  [
    'Модель',
    'Температура',
    'Выход, среднее',
    'Разных ответов',
    'Сохранены поля',
    'Лимит длины',
  ],
  temperatures.map((r) => [
    r.model,
    r.temperature,
    f(r.output),
    r.unique,
    r.preservesFields,
    r.lengthStops,
  ]),
)}

## Контекст

${table(
  ['Строк', 'Окно', 'Вход', 'Выход', 'Правильных кодов', 'Валидный JSON'],
  context.map((r) => [
    r.lines,
    r.numCtx,
    r.input,
    r.output,
    r.correct,
    r.validJSON,
  ]),
)}

## Приложение

${table(
  ['Вопрос', 'Вызовов', 'Вход', 'Выход', 'Всего', 'Стоимость'],
  app.map((r) => [
    r.question,
    r.calls,
    r.input,
    r.output,
    r.total,
    usd(r.cost),
  ]),
)}

Среднее: ${f(average.total)} токенов и ${usd(average.cost)} на вопрос.

## Сценарный прогноз, не реальная статистика пользователей

${table(
  [
    'Сценарий',
    'Вопросов',
    'Доля расписания',
    'Токенов/студента/день',
    '$/студента/день',
  ],
  scenarios.map((r) => [
    r.name,
    r.questions,
    f(r.scheduleShare * 100) + '%',
    f(r.tokens),
    usd(r.cost),
  ]),
)}
`;
await writeFile(new URL('MEASUREMENTS.md', import.meta.url), measured);
console.log(
  JSON.stringify(
    { requests: summary.requests, cost: totalCost, average, scenarios },
    null,
    2,
  ),
);
