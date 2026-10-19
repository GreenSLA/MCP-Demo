import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createScheduleCache } from '../server/schedule-cache.mjs';
import { downloadSchedule, scheduleResult } from '../server/schedule.mjs';

const initialTime = Date.parse('2026-10-19T09:00:00Z');
function data(details = 'Старая пара', fetchedAt = initialTime, mode = 'live') {
  return {
    mode,
    fetchedAt: new Date(fetchedAt).toISOString(),
    groups: [
      {
        group: '11-401',
        label: '11-401',
        semester: '2026/2027',
        sheet: 'Расписание',
        lessons: [
          {
            day: 'понедельник',
            time: '08:30-10:00',
            details,
            cell: 'C3',
            sourceCell: 'C3',
          },
        ],
      },
    ],
  };
}

void test('downloads on first request, reuses cache, refreshes after TTL and persists changed lessons', async () => {
  let time = initialTime,
    downloads = 0;
  const saved = [];
  const store = createScheduleCache({
    now: () => time,
    download: async () => {
      downloads++;
      return data(downloads === 1 ? 'Первая версия' : 'Новая пара', time);
    },
    writeCache: async (d) => saved.push(d),
    refreshIntervalMs: 300_000,
  });
  assert.equal(
    (await store.load()).groups[0].lessons[0].details,
    'Первая версия',
  );
  time += 299_999;
  await store.load();
  assert.equal(downloads, 1);
  time++;
  const updated = await store.load();
  assert.equal(downloads, 2);
  assert.equal(saved.length, 2);
  assert.equal(updated.groups[0].lessons[0].details, 'Новая пара');
  assert.equal(updated.stale, false);
});

void test('bundled snapshot is only an offline fallback, not a permanent source', async () => {
  let downloads = 0;
  const store = createScheduleCache({
    readFallback: async () =>
      data('Встроенная копия', initialTime - 86400_000, 'snapshot'),
    now: () => initialTime,
    download: async () => {
      downloads++;
      return data('Из Google');
    },
  });
  const live = await store.load();
  assert.equal(downloads, 1);
  assert.equal(live.mode, 'live');
  assert.equal(live.groups[0].lessons[0].details, 'Из Google');
});

void test('network failure preserves fetchedAt, marks cached data stale, backs off and then recovers', async () => {
  let time = initialTime + 300_000,
    downloads = 0,
    online = false,
    writes = 0;
  const store = createScheduleCache({
    now: () => time,
    readCache: async () => data(),
    download: async () => {
      downloads++;
      if (!online) throw Error('offline');
      return data('Изменено', time);
    },
    writeCache: async () => {
      writes++;
    },
  });
  const fallback = await store.load();
  assert.equal(fallback.stale, true);
  assert.equal(fallback.fetchedAt, data().fetchedAt);
  assert.equal(fallback.refreshError, 'offline');
  assert.equal(writes, 0);
  const result = scheduleResult(fallback, { group: '11-401' });
  assert.equal(result.stale, true);
  assert.match(result.warnings[0], /актуальность не удалось подтвердить/);
  time += 29_999;
  await store.load();
  assert.equal(downloads, 1);
  online = true;
  time++;
  const recovered = await store.load();
  assert.equal(recovered.stale, false);
  assert.equal(recovered.refreshError, undefined);
  assert.equal(writes, 1);
});

void test('concurrent refresh requests share a download and explicit refresh bypasses fresh TTL', async () => {
  let finish,
    downloads = 0;
  const store = createScheduleCache({
    download: () => {
      downloads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const first = store.load(),
    second = store.load(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(downloads, 1);
  finish(data());
  await Promise.all([first, second]);
  const forced = store.load(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(downloads, 2);
  finish(data('Новая пара'));
  await forced;
});

void test('corrupt disk cache does not block network and invalid download never replaces last good copy', async () => {
  let saved = 0;
  const store = createScheduleCache({
    readCache: async () => {
      throw Error('Invalid JSON');
    },
    readFallback: async () => data('Последняя копия', initialTime, 'snapshot'),
    download: async () => ({ ...data(), groups: [] }),
    writeCache: async () => {
      saved++;
    },
  });
  const fallback = await store.load();
  assert.equal(fallback.groups[0].lessons[0].details, 'Последняя копия');
  assert.equal(saved, 0);
  assert.equal(fallback.stale, true);
  await assert.rejects(
    store.load(true, { strict: true }),
    /пустая или некорректная/,
  );
  const empty = createScheduleCache({
    download: async () => {
      throw Error('offline');
    },
  });
  await assert.rejects(empty.load(), /offline/);
});

void test('startup refresh and timer update without user requests; timer is stopped and unrefed', async () => {
  let time = initialTime,
    callback,
    interval,
    unrefed = false,
    cleared = false,
    downloads = 0;
  const timer = {
    unref() {
      unrefed = true;
    },
  };
  const store = createScheduleCache({
    now: () => time,
    download: async () => {
      downloads++;
      return data('Версия ' + downloads, time);
    },
    setIntervalFn: (cb, ms) => {
      callback = cb;
      interval = ms;
      return timer;
    },
    clearIntervalFn: (t) => {
      assert.equal(t, timer);
      cleared = true;
    },
  });
  const stop = store.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(downloads, 1);
  assert.equal(unrefed, true);
  assert.equal(interval, 30_000);
  time += 300_000;
  await callback();
  assert.equal(downloads, 2);
  assert.equal((await store.load()).groups[0].lessons[0].details, 'Версия 2');
  stop();
  assert.equal(cleared, true);
});

void test('fresh disk cache survives restart and disk write failure still serves fresh network data', async () => {
  let downloads = 0;
  const reused = createScheduleCache({
    now: () => initialTime,
    readCache: async () => data(),
    download: async () => {
      downloads++;
      return data();
    },
  });
  await reused.load();
  assert.equal(downloads, 0);
  const noDisk = createScheduleCache({
    download: async () => data('Свежее'),
    now: () => initialTime,
    writeCache: async () => {
      throw Error('disk full');
    },
  });
  const fresh = await noDisk.load();
  assert.equal(fresh.stale, false);
  assert.ok(fresh.cacheError);
});

void test('Google XLSX export is parsed with ExcelJS, with HTTP/invalid-workbook errors propagated', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Расписание');
  sheet.getCell('C2').value = '11-401';
  sheet.getCell('A3').value = 'ПОНЕДЕЛЬНИК';
  sheet.getCell('B3').value = '08.30-10.00';
  sheet.getCell('C3').value = 'Новая дисциплина\n1306';
  const bytes = await workbook.xlsx.writeBuffer();
  const parsed = await downloadSchedule(async (url, options) => {
    assert.match(url, /export\?format=xlsx$/);
    assert.equal(options.cache, 'no-store');
    return new Response(bytes);
  });
  assert.equal(parsed.groups[0].lessons[0].details, 'Новая дисциплина\n1306');
  await assert.rejects(
    downloadSchedule(async () => new Response('', { status: 503 })),
    /HTTP 503/,
  );
  await assert.rejects(
    downloadSchedule(async () => new Response('<html>login</html>')),
  );
});
