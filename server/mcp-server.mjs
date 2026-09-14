/** Independent MCP server, JSON-RPC over stdio. stdout is reserved for MCP. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchKfu, readPage, indexStatus } from './knowledge.mjs';
import { getGroupSchedule } from './schedule.mjs';
const server = new McpServer({ name: 'kfu-itis-knowledge', version: '1.0.0' });
const result = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});
const wrap = (fn) => async (args) => {
  try {
    return result(await fn(args));
  } catch (e) {
    return { ...result({ error: e.message }), isError: true };
  }
};
server.registerTool(
  'search_kfu',
  {
    description:
      'Ищет информацию об ИТИС на официальных сайтах КФУ. Загружает HTML из интернета и ранжирует ограниченный корпус. Возвращает выдержки, URL и время получения; не охватывает весь интернет.',
    inputSchema: {
      query: z.string().min(2).max(500),
      limit: z.number().int().min(1).max(6).default(5),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap(({ query, limit }) => searchKfu(query, limit)),
);
server.registerTool(
  'read_kfu_page',
  {
    description:
      'Читает официальную HTML-страницу КФУ по URL. Используй после поиска для проверки деталей. Возвращает текст и ссылки, включая ссылки на PDF (содержимое PDF не читается).',
    inputSchema: { url: z.string().url(), refresh: z.boolean().default(false) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap(async ({ url, refresh }) => {
    const p = await readPage(url, refresh);
    return {
      ...p,
      text: p.text.slice(0, 22000),
      links: p.links
        .filter(
          (l) =>
            l.url.includes('/itis') || l.url.includes('admissions.kpfu.ru'),
        )
        .slice(0, 45),
    };
  }),
);
server.registerTool(
  'get_group_schedule',
  {
    description:
      'Получает само расписание группы ИТИС из предоставленной Google-таблицы, включая объединённые ячейки общих лекций. Возвращает время, дисциплины, преподавателей, аудитории и исходные условия по подгруппам/неделям. Если номер группы неизвестен, передай пустую строку. Для расписания используй этот инструмент вместо поиска по сайту.',
    inputSchema: {
      group: z.string().max(40).default(''),
      day: z
        .string()
        .max(40)
        .default('')
        .describe(
          'День недели, сегодня, завтра, дата ГГГГ-ММ-ДД; пустая строка — вся неделя.',
        ),
      refresh: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap(getGroupSchedule),
);
server.registerResource(
  'about',
  'itis://about',
  {
    description: 'Описание источников и ограничений MCP-сервера',
    mimeType: 'application/json',
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: JSON.stringify({
          name: 'ИТИС Навигатор',
          sources: ['https://kpfu.ru/itis', 'https://admissions.kpfu.ru/'],
          ...indexStatus(),
          cacheTtlMinutes: 30,
          limitations: [
            'Ограниченный корпус HTML',
            'PDF не извлекаются',
            'Сведения могут устареть',
          ],
        }),
      },
    ],
  }),
);
await server.connect(new StdioServerTransport());
