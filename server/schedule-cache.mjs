/** Refresh policy, independent of Google Sheets, Excel parsing and the filesystem. */
export const DEFAULT_SCHEDULE_REFRESH_MS = 5 * 60 * 1000;

export function validateScheduleData(data) {
  if (
    !data ||
    !Number.isFinite(Date.parse(data.fetchedAt)) ||
    !Array.isArray(data.groups) ||
    !data.groups.length ||
    !data.groups.every(
      (g) =>
        typeof g.group === 'string' &&
        typeof g.label === 'string' &&
        Array.isArray(g.lessons) &&
        g.lessons.every(
          (l) =>
            typeof l.day === 'string' &&
            typeof l.time === 'string' &&
            typeof l.details === 'string',
        ),
    ) ||
    !data.groups.some((g) => g.lessons.length)
  )
    throw new Error('Получена пустая или некорректная таблица расписания.');
  return data;
}

export function createScheduleCache({
  download,
  readCache = async () => null,
  readFallback = async () => null,
  writeCache = async () => {},
  refreshIntervalMs = DEFAULT_SCHEDULE_REFRESH_MS,
  retryIntervalMs = Math.min(30_000, refreshIntervalMs),
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onError = () => {},
}) {
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 1000)
    throw new Error(
      'Интервал обновления расписания должен быть не меньше 1000 мс.',
    );
  let cached, initializing, pending, lastError, persistenceError, timer;
  let nextAttemptAt = 0;

  async function initialize() {
    if (!initializing)
      initializing = (async () => {
        for (const read of [readCache, readFallback]) {
          try {
            const data = validateScheduleData(await read());
            cached = data;
            break;
          } catch {
            // Missing/corrupt cache must not prevent an attempt to download fresh data.
          }
        }
      })();
    await initializing;
  }

  function snapshot() {
    return {
      ...cached,
      stale:
        cached.mode !== 'live' ||
        !!lastError ||
        now() - Date.parse(cached.fetchedAt) >= refreshIntervalMs,
      refreshIntervalMs,
      ...(lastError ? { refreshError: lastError.message } : {}),
      ...(persistenceError
        ? { cacheError: 'Не удалось сохранить копию на диск.' }
        : {}),
    };
  }

  async function refresh() {
    try {
      const data = validateScheduleData(await download());
      cached = { ...data, mode: 'live' };
      lastError = undefined;
      nextAttemptAt = now() + refreshIntervalMs;
      try {
        await writeCache(cached);
        persistenceError = undefined;
      } catch (e) {
        // Fresh network data is usable even if disk persistence fails.
        persistenceError = e;
        onError(e);
      }
    } catch (e) {
      lastError = e;
      nextAttemptAt = now() + retryIntervalMs;
      onError(e);
    }
  }

  async function load(force = false, { strict = false } = {}) {
    await initialize();
    const stale =
      !cached ||
      cached.mode !== 'live' ||
      now() - Date.parse(cached.fetchedAt) >= refreshIntervalMs;
    if (force || pending || ((stale || lastError) && now() >= nextAttemptAt)) {
      if (!pending)
        pending = refresh().finally(() => {
          pending = undefined;
        });
      await pending;
    }
    if (lastError && (strict || !cached)) throw lastError;
    if (!cached)
      throw new Error('Расписание пока недоступно. Повтори запрос позже.');
    return snapshot();
  }

  function start() {
    if (timer) return stop;
    // Start immediately, without delaying the MCP transport handshake.
    void load(true).catch(() => {});
    timer = setIntervalFn(
      () => load().catch(() => {}),
      Math.min(refreshIntervalMs, retryIntervalMs),
    );
    timer.unref?.();
    return stop;
  }
  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = undefined;
  }
  return { load, start, stop };
}
