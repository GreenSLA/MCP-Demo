import test from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl, parsePage, terms, rank } from '../server/knowledge.mjs';
import { runAgent } from '../server/agent.mjs';

test('retrieval accepts university URLs and rejects external/private targets', () => {
  assert.equal(safeUrl('http://kpfu.ru/itis#top'), 'https://kpfu.ru/itis');
  assert.equal(
    safeUrl('https://admissions.kpfu.ru/'),
    'https://admissions.kpfu.ru/',
  );
  for (const url of [
    'https://kpfu.ru.evil.test/',
    'http://127.0.0.1/',
    'file:///etc/passwd',
    'https://kpfu.ru:8000/',
    'https://u:p@kpfu.ru/',
  ])
    assert.throws(() => safeUrl(url));
});
test('extracts actual KFU content despite an empty #content and strips scripts', () => {
  const p = parsePage(
    '<html><head><title>ИТИС</title></head><body><div id="content"></div><div id="ss_content"><h1>Контакты ИТИС</h1><p>' +
      'Университет в Казани. '.repeat(8) +
      '</p><script>evil()</script><a href="/itis/contacts">Контакты</a><a href="https://evil.test">Внешний</a></div></body></html>',
    'https://kpfu.ru/itis',
  );
  assert.ok(p.text.includes('Казани'));
  assert.ok(!p.text.includes('evil()'));
  assert.equal(p.links.length, 1);
  assert.equal(p.links[0].url, 'https://kpfu.ru/itis/contacts');
});
test('Russian query ranking ignores generic university words', () => {
  const t = terms('Какие стипендиальные программы есть в ИТИС?');
  assert.ok(rank('Стипендиальные программы', t) > rank('Новости ИТИС', t));
});
test('agent dispatches MCP calls, preserves tool IDs and returns real source URLs', async () => {
  const calls = [],
    events = [];
  let turn = 0;
  const mcp = {
    tools: [{ type: 'function', function: { name: 'search_kfu' } }],
    client: {
      callTool: async (args) => {
        calls.push(args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                results: [
                  {
                    url: 'https://kpfu.ru/itis',
                    title: 'ИТИС',
                    excerpt: 'Факты',
                  },
                ],
                indexedPages: 1,
              }),
            },
          ],
        };
      },
    },
  };
  await runAgent({
    mcp,
    key: 'test',
    model: 'test',
    history: [{ role: 'user', content: 'Где ИТИС?' }],
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    complete: async ({ messages, toolChoice }) => {
      if (turn++ === 0) {
        assert.equal(toolChoice.function.name, 'search_kfu');
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'search_kfu',
                arguments: '{"query":"контакты"}',
              },
            },
          ],
        };
      }
      assert.equal(messages.at(-1).tool_call_id, 'call-1');
      return { role: 'assistant', content: '[ИТИС](https://kpfu.ru/itis)' };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(events.at(-1).type, 'answer');
  assert.equal(events.at(-1).sources[0].url, 'https://kpfu.ru/itis');
});
test('failed MCP tool becomes an error observation, never a fabricated source', async () => {
  const events = [];
  let turn = 0;
  await runAgent({
    mcp: {
      tools: [{ function: { name: 'search_kfu' } }],
      client: {
        callTool: async () => {
          throw new Error('Сайт недоступен');
        },
      },
    },
    key: '',
    model: '',
    history: [],
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    complete: async () =>
      turn++
        ? { role: 'assistant', content: 'Источник недоступен.' }
        : {
            role: 'assistant',
            tool_calls: [
              { id: 'x', function: { name: 'search_kfu', arguments: '{}' } },
            ],
          },
  });
  assert.equal(events.find((e) => e.type === 'tool').step.status, 'error');
  assert.deepEqual(events.at(-1).sources, []);
});

test('OpenRouter request headers can be encoded by fetch (ByteString regression)', async () => {
  const { completion } = await import('../server/agent.mjs');
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.doesNotThrow(() => new Headers(options.headers));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
      }),
    };
  };
  try {
    assert.equal(
      (
        await completion({
          key: 'test',
          model: 'test',
          messages: [],
          tools: [],
          toolChoice: 'none',
          signal: new AbortController().signal,
        })
      ).content,
      'OK',
    );
  } finally {
    globalThis.fetch = original;
  }
});
