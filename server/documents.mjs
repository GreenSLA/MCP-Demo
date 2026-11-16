import { safeUrl } from './knowledge.mjs';

const filler = new Set(
  'как где кто куда можно нужно хочу подскажи скажи мне найти посмотреть какой какая какие сколько что когда про для по ли это итис кфу университет институт'.split(
    ' ',
  ),
);

export async function searchDocs(store, { query, limit = 3 }) {
  const words = [
    ...new Set(
      (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(
        (word) => word.length > 2 && !filler.has(word),
      ),
    ),
  ].slice(0, 12);
  if (!words.length) return { results: [] };
  const { rows } = await store.query(
    `WITH request AS (SELECT websearch_to_tsquery('russian',$1) AS terms)
    SELECT id,title,url,version,valid_from,valid_until,body AS excerpt,
      ts_rank(search_vector,request.terms) AS score
    FROM documents CROSS JOIN request WHERE approved
    AND (valid_from IS NULL OR valid_from<=(now() AT TIME ZONE 'Europe/Moscow')::date)
    AND (valid_until IS NULL OR valid_until>=(now() AT TIME ZONE 'Europe/Moscow')::date)
    AND search_vector @@ request.terms
    ORDER BY score DESC,id LIMIT $2`,
    [words.join(' OR '), limit],
  );
  return {
    results: rows.flatMap((row) => {
      try {
        return [
          {
            ...row,
            url: safeUrl(row.url),
            excerpt: row.excerpt.slice(0, 1600),
          },
        ];
      } catch {
        return [];
      }
    }),
  };
}

export async function documentsViaMcp(
  mcp,
  question,
  signal,
  name = 'search_docs',
) {
  const response = await mcp.client.callTool(
    { name, arguments: { query: question.slice(0, 500) } },
    undefined,
    { signal, timeout: 15000 },
  );
  if (response.isError)
    throw new Error('Не удалось выполнить поиск по документам.');
  return JSON.parse(
    response.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n'),
  ).results;
}
