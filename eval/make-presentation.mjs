// Run a copy from work/ai-lab with the bundled @oai/artifact-tool runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Presentation, PresentationFile } from '@oai/artifact-tool';
const root = process.cwd();
const summary = JSON.parse(
  await fs.readFile(path.join(root, 'eval/summary.json'), 'utf8'),
);
const skill =
  '/Users/viacheslav/.codex/plugins/cache/openai-primary-runtime/presentations/26.1011.11113/skills/presentations';
const runtime =
  '/Users/viacheslav/.cache/codex-runtimes/codex-primary-runtime/dependencies';
process.env.RUNTIME_NODE_MODULES = path.join(runtime, 'node/node_modules');
const build = path.join(root, 'work/ai-lab');
const finalPath = path.join(root, 'deliverables/ITIS_E1-E5.pptx');
const P = Presentation.create({ slideSize: { width: 1280, height: 720 } });
const C = {
  bg: '#F7F7F2',
  ink: '#142D29',
  accent: '#26785F',
  muted: '#5F6D67',
  white: '#FFFFFF',
  line: '#D2DBD4',
};
const FONT = 'Arial';
function text(s, t, x, y, w, h, size = 28, color = C.ink, bold = false) {
  const o = s.shapes.add({
    geometry: 'textbox',
    position: { left: x, top: y, width: w, height: h },
    fill: 'none',
    line: { fill: 'none', width: 0 },
  });
  o.text = t;
  o.text.style = { typeface: FONT, fontSize: size, color, bold, wrap: true };
  return o;
}
function slide(title, notes = '') {
  const s = P.slides.add();
  s.background.fill = C.bg;
  text(s, title, 68, 48, 1144, 100, 44, C.ink, true);
  s.speakerNotes.text = notes;
  text(
    s,
    String(P.slides.items.length).padStart(2, '0'),
    1165,
    658,
    45,
    30,
    18,
    C.muted,
  );
  return s;
}
function table(s, values, { x = 68, y = 175, w = 1144, h = 390, widths } = {}) {
  const tb = s.tables.add({
    rows: values.length,
    columns: values[0].length,
    left: x,
    top: y,
    width: w,
    height: h,
    values,
    columnWidths: widths,
  });
  tb.borders.assign({ fill: C.line, width: 1, style: 'solid' });
  for (let r = 0; r < values.length; r++)
    for (let c = 0; c < values[0].length; c++) {
      const ce = tb.getCell(r, c);
      ce.fill = r === 0 ? C.ink : r % 2 ? C.white : '#EBF0EB';
      ce.text.style = {
        typeface: FONT,
        fontSize: 25,
        color: r === 0 ? C.white : C.ink,
        bold: r === 0,
      };
    }
  return tb;
}
const n = (n) =>
  Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
let s = slide('');
text(s, 'ИТИС Навигатор', 68, 100, 1120, 75, 64, C.ink, true);
text(
  s,
  'Промпт и проверка\nкачества ответов',
  68,
  208,
  1120,
  190,
  72,
  C.ink,
  true,
);
text(s, 'Практика E1–E5\n12 октября 2026', 72, 500, 1000, 90, 28, C.muted);
s.speakerNotes.text =
  'Работа относится к нашему MCP-помощнику по ИТИС КФУ. Мы проверяем финальный ответ после получения данных от инструментов. Числа в презентации получены в локальном эксперименте. Источник: eval/REPORT.md, условия E1–E5 из скриншотов.';
s = slide(
  'Проверка ответа в нашем проекте',
  'Обычные вопросы идут через MCP-поиск и модель. Расписание в интерфейсе поступает напрямую из данных и не нуждается в генерации. В этой работе изолирован этап финального ответа модели. Источник: server/agent.mjs, server/schedule-request.mjs, eval/ASSIGNMENT.md.',
);
text(s, '1', 68, 188, 80, 60, 42, C.accent, true);
text(s, 'MCP возвращает сведения и источник', 155, 187, 1000, 65, 34);
text(s, '2', 68, 300, 80, 60, 42, C.accent, true);
text(s, 'Модель формулирует ответ по промпту', 155, 299, 1000, 65, 34);
text(s, '3', 68, 412, 80, 60, 42, C.accent, true);
text(s, 'Код проверяет JSON перед показом', 155, 411, 1000, 65, 34);
text(
  s,
  'Расписание в интерфейсе работает через отдельный прямой маршрут.',
  68,
  580,
  1100,
  65,
  24,
  C.muted,
);
s = slide(
  'Условия сравнения',
  'Использовали Qwen3.5:9b через Ollama на M4 Pro. OpenRouter вернул API key expired, поэтому все новые цифры относятся к локальной модели. Источники: eval/questions.json, eval/results/v0.jsonl и v1.jsonl. Один прогон, выборка небольшая.',
);
table(
  s,
  [
    ['Параметр', 'Условие'],
    ['Вопросы', '30 одинаковых сценариев'],
    ['Данные инструментов', '9 сценариев с данными MCP, 21 граничный случай'],
    ['Модель и температура', 'Qwen3.5:9b, temperature = 0,2'],
    ['Контекст и генерация', '16 384 токена, максимум 800 токенов ответа'],
    ['Что меняется', 'Системный промпт и три примера ответа'],
  ],
  { widths: [345, 799], h: 370 },
);
text(
  s,
  'Автономный выбор инструмента в этом сравнении не измеряли.',
  68,
  594,
  1130,
  55,
  24,
  C.muted,
);
s = slide(
  'E1. Разметка исходных ответов',
  'Каждый ответ сверили с сохранённым результатом инструмента. Разметку выполнил ИИ-ассистент с пояснениями по каждому вопросу, независимой человеческой оценки не было. Формат JSON учитывается отдельно, поскольку v0 был рассчитан на обычный текст. Источник: eval/labels_v0.json.',
);
table(
  s,
  [
    ['Тип', 'Что проверяем'],
    ['Выдумал', 'Утверждение не подтверждено результатом инструмента'],
    ['Не по теме', 'Бот выполняет постороннюю просьбу'],
    ['Формат', 'Избыточный ответ или нарушение заданного ограничения'],
    ['Не понял', 'Бот отвечает на другой вопрос'],
  ],
  { widths: [280, 864], h: 330 },
);
text(
  s,
  `В v0 нашли ${summary.contentBad.v0} ответов с содержательной ошибкой или нарушением краткости.`,
  68,
  552,
  1130,
  90,
  29,
  C.accent,
  true,
);
s = slide(
  'E2. Пять частей системного промпта',
  'Промпт лежит в prompts/system_v1.md и читается кодом при запросе. Важное добавление: при противоречащих сведениях не выбирать одно значение без основания. Ошибка может привести студента в неверную аудиторию. Источник: prompts/system_v1.md и server/answer.mjs.',
);
table(
  s,
  [
    ['Часть', 'Правило для ИТИС Навигатора'],
    ['Роль и ситуация', 'Помощник студентов ИТИС КФУ'],
    ['Границы', 'Университетские вопросы, уточнение неоднозначности'],
    ['Источник фактов', 'Только результаты текущих успешных инструментов'],
    ['«Не знаю»', 'Признать нехватку данных, подсказать следующий шаг'],
    ['Форма', 'Краткий текст внутри JSON с тремя полями'],
  ],
  { widths: [330, 814], h: 390 },
);
s = slide(
  'E3. Три примера в сообщениях',
  'Few-shot хранится в prompts/fewshot_v1.json. Учебные значения явно помечены и не используются как сведения об университете. На тех же пяти вопросах сравнили system-only и v1. Источник: eval/results/system-only.jsonl, v1.jsonl и eval/summary.json.',
);
text(s, 'Обычный ответ', 68, 182, 460, 55, 34, C.accent, true);
text(s, 'Аудитория из результата инструмента', 590, 187, 620, 70, 29);
text(s, 'Отказ', 68, 290, 460, 55, 34, C.accent, true);
text(s, 'Короткое обозначение специализации', 590, 295, 620, 70, 29);
text(s, '«Не знаю»', 68, 398, 460, 55, 34, C.accent, true);
text(s, 'Нет подтверждения, есть следующий шаг', 590, 403, 620, 70, 29);
text(
  s,
  `Цена примеров: +${n(summary.fewshot.meanExtraInput)} входных токенов на вызов`,
  68,
  540,
  1120,
  65,
  36,
  C.ink,
  true,
);
text(s, 'Среднее по пяти одинаковым вопросам.', 68, 610, 1100, 45, 23, C.muted);
s = slide(
  'E4. Контракт финального ответа',
  'Проверяем обязательные поля, типы, лишние поля, даты при found=false и наличие успешного инструмента при found=true. JSON Schema не доказывает истинность содержимого. Источник: server/answer.mjs и tests/answer.test.mjs.',
);
text(
  s,
  '{\n  "answer": "Уточните номер группы.",\n  "source_tool": null,\n  "found": false\n}',
  70,
  174,
  1120,
  245,
  34,
  C.ink,
);
text(
  s,
  'found=false: в ответе нет конкретной даты или времени.',
  68,
  470,
  1130,
  70,
  30,
  C.accent,
  true,
);
text(
  s,
  'Код проверяет структуру и условия, факты сверяются с источником.',
  68,
  575,
  1120,
  75,
  26,
  C.muted,
);
s = slide(
  'E4. Одна попытка исправления',
  'Сначала проверяем первый ответ. При нарушении отправляем текст ошибки и просим исправить. После второго неверного ответа возвращаем честный объект found=false. Нативный режим JSON включён на повторе. Отдельные unit-тесты проверили оба пути, даже если естественных ошибок мало. Источники: eval/results/validated.jsonl, server/answer.mjs.',
);
table(
  s,
  [
    ['Результат проверки', 'Количество'],
    ['Валидный первый ответ v1', `${summary.validation.firstValid} из 30`],
    ['Дополнительные запросы', String(summary.validation.retries)],
    ['Запасной ответ после проверки', String(summary.validation.fallbacks)],
    ['Валидный итоговый объект', `${summary.validation.finalValid} из 30`],
  ],
  { widths: [870, 274], h: 320 },
);
text(
  s,
  '7 ответов с found=true не дают точного ответа на вопрос.',
  68,
  570,
  1130,
  70,
  30,
  C.accent,
  true,
);
s = slide(
  'E5. Сравнение версий',
  'Оценивали ответ студенту, а не только JSON-обёртку. Каждый ответ имеет один основной тип ошибки. JSON выводится отдельной строкой и не прибавляется к содержательным ошибкам. Источники: eval/labels_v0.json, labels_v1.json, summary.json.',
);
table(
  s,
  [
    ['Критерий', 'v0', 'v1'],
    ...summary.comparison.map((r) => [r.type, String(r.v0), String(r.v1)]),
    [
      'Всего плохих ответов по содержанию',
      String(summary.contentBad.v0),
      String(summary.contentBad.v1),
    ],
    [
      'Валидный JSON с первого раза',
      `${summary.validation.baselineValid}/30`,
      `${summary.validation.firstValid}/30`,
    ],
  ],
  { widths: [790, 177, 177], h: 430, y: 162 },
);
text(
  s,
  'Сравнение первых ответов v1, до программного исправления.',
  68,
  607,
  1120,
  45,
  23,
  C.muted,
);
s = slide(
  'Пример ответа до и после',
  'Обе версии получили один и тот же недельный шаблон. Не оцениваем прямую карточку расписания: это тест формулировки модели на фиксированном результате инструмента. Источник: q01 в eval/results/v0.jsonl и v1.jsonl.',
);
text(
  s,
  'Вопрос: когда начинается первая пара?',
  68,
  163,
  1130,
  60,
  32,
  C.ink,
  true,
);
text(s, 'v0', 68, 263, 120, 65, 38, C.muted, true);
text(
  s,
  'Правильное время, затем перечень всех пар\nи лишние подробности на весь день.',
  230,
  267,
  950,
  120,
  31,
);
text(s, 'v1', 68, 436, 120, 65, 38, C.accent, true);
text(s, summary.exampleAfter, 230, 434, 950, 150, 31);
s = slide(
  'Ограничения и следующий шаг',
  'Не заявляем, что устранены все галлюцинации или исправлен выбор инструмента. Снимки отсекают изменения сайта, но не воспроизводят весь агентный цикл. Источники: eval/REPORT.md, eval/labels_v1.json.',
);
text(
  s,
  'Один прогон на небольшой контрольной выборке',
  68,
  182,
  1120,
  80,
  34,
  C.ink,
  true,
);
text(
  s,
  'Искусственные случаи проверяют ошибки и нехватку данных.',
  68,
  282,
  1120,
  75,
  29,
);
text(
  s,
  'Разметка ассистентом требует проверки человеком.',
  68,
  387,
  1120,
  75,
  29,
);
text(
  s,
  'Следующая проверка: реальные диалоги и выбор MCP-инструмента.',
  68,
  495,
  1120,
  95,
  29,
  C.accent,
  true,
);
s = slide(
  'Материалы для повторения',
  'Запуск: node eval/run.mjs v0; node eval/run.mjs v1; node eval/run.mjs system-only; node eval/run.mjs validated; node eval/analyze.mjs. Сервер Ollama должен быть запущен и qwen3.5:9b установлена. Все результаты этого запуска сохранены, перезапуск продолжает только отсутствующие строки при совпадении конфигурации. Источник: README.md и eval/REPORT.md.',
);
table(
  s,
  [
    ['Материал', 'Путь в репозитории'],
    ['Промпт и примеры', 'prompts/system_v1.md, fewshot_v1.json'],
    ['Вопросы и ответы инструментов', 'eval/questions.json, snapshots.json'],
    [
      'Исходные ответы и разметка',
      'eval/results/, labels_v0.json, labels_v1.json',
    ],
    ['Схема, повтор, запасной ответ', 'server/answer.mjs'],
    ['Отчёт и команды запуска', 'eval/REPORT.md'],
  ],
  { widths: [460, 684], h: 370 },
);
await fs.mkdir(build, { recursive: true });
for (const [i, sl] of P.slides.items.entries()) {
  const blob = await P.export({ slide: sl, format: 'png', scale: 1 });
  await fs.writeFile(
    path.join(build, `slide-${String(i + 1).padStart(2, '0')}.png`),
    new Uint8Array(await blob.arrayBuffer()),
  );
}
await (
  await PresentationFile.exportPptx(P)
).save(path.join(build, 'draft-v3.pptx'));
const { finalizePresentation } = await import(
  pathToFileURL(path.join(skill, 'container_tools/artifact_tool_utils.mjs'))
    .href
);
await finalizePresentation({
  workspaceDir: root,
  candidatePath: path.join(build, 'draft-v3.pptx'),
  finalPath,
  pythonExecutable: path.join(runtime, 'python/bin/python3'),
  integrityValidatorPath: path.join(
    skill,
    'container_tools/inspect_presentation_package_integrity.py',
  ),
  layoutValidatorPath: path.join(
    skill,
    'container_tools/inspect_presentation_layout_geometry.py',
  ),
  layoutArgs: [
    '--expected-slide-size-emu',
    '12192000,6858000',
    '--validate-heading-fit',
    ...[3, 4, 5, 8, 9, 12].flatMap((n) => [
      '--require-native-table-slide',
      String(n),
    ]),
  ],
  requiredNativeTableOwnerSlides: [3, 4, 5, 8, 9, 12],
  tableArithmeticContracts: [
    {
      slide: 9,
      table: 1,
      label_column: 0,
      total_row: 5,
      value_columns: [1, 2],
      component_rows: [1, 2, 3, 4],
    },
  ],
  fontPolicy: { basis: 'design', families: [FONT] },
  verifyArtifactToolImport: true,
  receiptPath: path.join(build, 'validation.json'),
});
console.log(finalPath);
