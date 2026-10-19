import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAnswer,
  ask,
  loadPrompts,
  containsDate,
} from '../server/answer.mjs';
const stringify = (answer, source_tool = null, found = false) =>
  JSON.stringify({ answer, source_tool, found });
test('strict answer schema rejects missing/extra fields, false-found dates and invented source tools', () => {
  for (const text of [
    '{"answer":"x"}',
    '{"answer":"x","found":false,"source_tool":null,"extra":1}',
    stringify('Пересдача 14 января.'),
    stringify('В 10:15.'),
    stringify('Завтра.'),
    stringify('Кабинет 1505.', 'read_kfu_page', true),
  ])
    assert.throws(() => validateAnswer(text));
  assert.equal(
    validateAnswer(stringify('Не нашёл подтверждённого срока.')).found,
    false,
  );
  assert.equal(
    validateAnswer(stringify('Кабинет 1505.', 'read_kfu_page', true), {
      successfulTools: ['read_kfu_page'],
    }).found,
    true,
  );
  assert.equal(
    containsDate(
      'Время не подтверждено. [Источник](https://kpfu.ru/2026/10/12)',
    ),
    false,
  );
});
test('ask repairs once with validation error and then accepts a valid object', async () => {
  let calls = 0;
  const r = await ask({
    messages: [{ role: 'user', content: 'Когда пересдача?' }],
    initialMessage: { content: stringify('14 января.') },
    complete: async ({ messages, responseFormat }) => {
      calls++;
      assert.match(messages.at(-1).content, /found=false/);
      assert.equal(responseFormat.type, 'json_schema');
      return {
        content: stringify('Срок не подтверждён. Уточните в учебном офисе.'),
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(r.attempts, 2);
  assert.equal(r.fallback, false);
});
test('two invalid outputs produce an honest valid fallback with no third generation', async () => {
  let calls = 0;
  const r = await ask({
    messages: [],
    complete: async () => {
      calls++;
      return { content: 'не JSON' };
    },
  });
  assert.equal(calls, 2);
  assert.equal(r.fallback, true);
  assert.equal(r.answer.found, false);
  assert.deepEqual(validateAnswer(JSON.stringify(r.answer)), r.answer);
});
test('a valid initial response incurs no repair call', async () => {
  const r = await ask({
    messages: [],
    initialMessage: { content: stringify('Уточните номер группы.') },
    complete: () => assert.fail('Unexpected retry'),
  });
  assert.equal(r.attempts, 1);
  assert.equal(r.fallback, false);
});
test('prompts come from versioned files and examples are three real message pairs', () => {
  const v0 = loadPrompts('v0', { today: '2026-10-12' }),
    v1 = loadPrompts('v1', { today: '2026-10-12' });
  assert.ok(v0.system.includes('2026-10-12'));
  assert.equal(v0.examples.length, 0);
  assert.equal(v1.examples.length, 6);
  assert.equal(loadPrompts('v1', { fewshot: false }).examples.length, 0);
  for (const ex of v1.examples.filter((e) => e.role === 'assistant'))
    assert.doesNotThrow(() => JSON.parse(ex.content));
});

test('agent integrates validation and exposes readable fallback after malformed responses', async () => {
  const { runAgent } = await import('../server/agent.mjs');
  const events = [];
  let calls = 0;
  await runAgent({
    mcp: { tools: [], client: {} },
    key: 'test',
    model: 'test',
    history: [{ role: 'user', content: 'Вопрос' }],
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    complete: async () => {
      calls++;
      return { role: 'assistant', content: null };
    },
  });
  assert.equal(calls, 2);
  const last = events.at(-1);
  assert.equal(last.type, 'answer');
  assert.equal(last.structured.found, false);
  assert.equal(last.validation.fallback, true);
  assert.equal(last.content, last.structured.answer);
});
