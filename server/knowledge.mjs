/** Public university retrieval. No LLM or API key is used in this module. */
import { load } from 'cheerio';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
const CACHE_FILE = new URL('../data/cache.json', import.meta.url);
const TTL = 30 * 60 * 1000;
export const SEEDS = [
  'https://kpfu.ru/itis',
  'https://kpfu.ru/itis/abiturientam-123538',
  'https://kpfu.ru/itis/obuchenie-v-itis',
  'https://kpfu.ru/itis/struktura-itis-123077',
  'https://kpfu.ru/itis/kompanii-partnery',
  'https://kpfu.ru/itis/obuchenie-v-itis/stipendialnye-programmy',
  'https://kpfu.ru/itis/zaselenie-v-obschezhitiya-itis',
  'https://kpfu.ru/itis/science',
  'https://kpfu.ru/itis/studencheskaya-zhizn',
  'https://kpfu.ru/itis/pochemu-itis',
  'https://kpfu.ru/itis/dopolnitelnoe-obrazovanie',
];
const pages = new Map();
const inFlight = new Map();
let warmPromise;
try {
  for (const p of JSON.parse(await readFile(CACHE_FILE, 'utf8')))
    pages.set(p.url, p);
} catch {
  /* First run. */
}

export function safeUrl(value) {
  const u = new URL(value);
  if (
    !['https:', 'http:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.port ||
    !(u.hostname === 'kpfu.ru' || u.hostname.endsWith('.kpfu.ru'))
  )
    throw new Error(
      'Разрешены только публичные страницы kpfu.ru и его поддоменов.',
    );
  u.protocol = 'https:';
  u.hash = '';
  return u.href;
}
export function parsePage(html, url, fetchedAt = new Date().toISOString()) {
  const $ = load(html);
  $('script,style,noscript,svg,iframe,form,header,footer,nav').remove();
  const links = [];
  $('a[href]').each((_, a) => {
    try {
      const href = safeUrl(new URL($(a).attr('href'), url).href);
      const title = $(a).text().replace(/\s+/g, ' ').trim();
      if (title && !links.some((l) => l.url === href))
        links.push({ url: href, title });
    } catch {
      /* Ignore external links. */
    }
  });
  const title =
    $('h1').first().text().trim() || $('title').text().trim() || 'КФУ · ИТИС';
  const root =
    ['#ss_content', 'article', 'main', '#content', 'body']
      .map((selector) => $(selector).first())
      .find((el) => el.text().trim().length > 100) || $('body');
  root.find('br').replaceWith('\n');
  root.find('p,li,h1,h2,h3,h4,tr,section').each((_, e) => {
    $(e).append('\n');
  });
  const text = root
    .text()
    .replace(/[\t \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 65000);
  return {
    url,
    title: title.replace(/\s+/g, ' ').slice(0, 220),
    text,
    links: links.slice(0, 200),
    fetchedAt,
  };
}
let saving = Promise.resolve();
async function persist() {
  saving = saving
    .catch(() => {})
    .then(async () => {
      await mkdir(new URL('../data/', import.meta.url), { recursive: true });
      const tmp = new URL(`../data/cache-${process.pid}.tmp`, import.meta.url);
      await writeFile(tmp, JSON.stringify([...pages.values()]));
      await rename(tmp, CACHE_FILE);
    });
  await saving;
}
async function download(url) {
  let current = safeUrl(url);
  for (let redirects = 0; redirects < 5; redirects++) {
    const r = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(18000),
      headers: {
        'User-Agent': 'ITIS-Navigator-Educational/1.0',
        Accept: 'text/html',
      },
    });
    if (r.status >= 300 && r.status < 400) {
      const location = r.headers.get('location');
      if (!location) throw new Error('Пустое перенаправление.');
      current = safeUrl(new URL(location, current).href);
      continue;
    }
    if (!r.ok) throw new Error(`Сайт вернул HTTP ${r.status}.`);
    const type = r.headers.get('content-type') || '';
    if (!type.includes('html') && !type.includes('text/plain'))
      throw new Error(
        'Этот формат не поддерживается. Сейчас доступны HTML-страницы; PDF откройте по ссылке.',
      );
    const chunks = [];
    let size = 0;
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new Error('Страница слишком большая.');
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    const hint = type + ' ' + bytes.subarray(0, 3000).toString('ascii');
    const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(hint)?.[1] || 'utf-8';
    const html = new TextDecoder(charset).decode(bytes);
    const page = parsePage(html, current);
    if (page.text.length < 80)
      throw new Error('На странице недостаточно доступного текста.');
    pages.set(current, page);
    if (current !== url) pages.set(url, { ...page, url });
    await persist();
    return page;
  }
  throw new Error('Слишком много перенаправлений.');
}
export async function readPage(url, refresh = false) {
  url = safeUrl(url);
  const cached = pages.get(url);
  if (!refresh && cached && Date.now() - Date.parse(cached.fetchedAt) < TTL)
    return { ...cached, cached: true };
  if (!inFlight.has(url))
    inFlight.set(
      url,
      download(url).finally(() => inFlight.delete(url)),
    );
  try {
    return await inFlight.get(url);
  } catch (e) {
    if (cached)
      return {
        ...cached,
        cached: true,
        stale: true,
        warning: `Сайт недоступен. Использована копия от ${cached.fetchedAt}.`,
      };
    throw e;
  }
}
async function batch(urls) {
  const results = [];
  for (let i = 0; i < urls.length; i += 4)
    results.push(
      ...(await Promise.allSettled(
        urls.slice(i, i + 4).map((url) => readPage(url)),
      )),
    );
  return results;
}
export async function warmIndex() {
  if (!warmPromise)
    warmPromise = batch(SEEDS).finally(() => {
      warmPromise = null;
    });
  await warmPromise;
  return { pages: pages.size };
}
const stop = new Set(
  'какие какой какая как где когда сколько это есть для или что кто чтобы мне меня про при кфу итис университет института институт информация информации узнать посмотреть пожалуйста'.split(
    ' ',
  ),
);
export function terms(query) {
  return [
    ...new Set(
      query
        .toLowerCase()
        .replace(/ё/g, 'е')
        .match(/[а-яa-z0-9]+/g)
        ?.filter((t) => t.length > 2 && !stop.has(t))
        .map((t) => (t.length > 5 ? t.slice(0, -2) : t)) || [],
    ),
  ];
}
export function rank(text, tokens) {
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  return tokens.reduce((s, t) => s + (lower.includes(t) ? 1 : 0), 0);
}
function excerpt(text, tokens) {
  const chunks = text.split(/\n\n|\n/).filter((s) => s.trim().length > 25);
  const ranked = chunks
    .map((text, i) => ({ text, i, score: rank(text, tokens) }))
    .sort((a, b) => b.score - a.score);
  return ranked
    .slice(0, 7)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.text)
    .join('\n')
    .slice(0, 4500);
}
export async function searchKfu(query, limit = 5) {
  await warmIndex();
  const tokens = terms(query);
  const candidates = new Map();
  for (const p of pages.values())
    for (const link of p.links) {
      if (
        pages.has(link.url) ||
        /\.(pdf|docx?|xlsx?|zip|jpe?g|png)(\?|$)/i.test(link.url)
      )
        continue;
      const relevance = rank(link.title, tokens);
      if (relevance > 0)
        candidates.set(link.url, { ...link, score: relevance });
    }
  await batch(
    [...candidates.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((l) => l.url),
  );
  const ranked = [
    ...new Map([...pages.values()].map((p) => [p.url, p])).values(),
  ]
    .map((p) => ({
      p,
      score: rank(p.title, tokens) * 4 + rank(p.text, tokens),
    }))
    .filter((x) => x.score > 0 || tokens.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return {
    query,
    strategy:
      'Поиск по официальным HTML-страницам КФУ: загрузка разделов ИТИС, переход по релевантным ссылкам, лексическое ранжирование. Это ограниченный корпус, не поиск по всему интернету.',
    indexedPages: pages.size,
    results: ranked.map(({ p, score }) => ({
      title: p.title,
      url: p.url,
      fetchedAt: p.fetchedAt,
      stale: Date.now() - Date.parse(p.fetchedAt) > TTL,
      score,
      excerpt: excerpt(p.text, tokens),
    })),
  };
}
export function indexStatus() {
  return { pages: pages.size };
}
