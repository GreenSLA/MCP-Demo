import { normalizeGroup } from './schedule.mjs';
/** Cheap routing for timetable queries: works without LLM credentials. */
export function scheduleRequest(history) {
  const current = history.at(-1)?.content || '';
  const recent = history.slice(-4);
  const inSchedule = recent
    .slice(0, -1)
    .some((m) => /расписан|пары|занятия группы/i.test(m.content));
  const explicit =
    /расписан|\bпар[а-я]*\b|какие пары|когда пары|какие занятия/iu.test(
      current,
    );
  const group = normalizeGroup(current);
  const days = [
    ['понедельник', 'понедельник'],
    ['вторник', 'вторник'],
    ['сред', 'среда'],
    ['четверг', 'четверг'],
    ['пятниц', 'пятница'],
    ['суббот', 'суббота'],
    ['воскресень', 'воскресенье'],
  ];
  const relative = current
    .match(/послезавтра|завтра|сегодня/i)?.[0]
    .toLowerCase();
  const date = current.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  const weekday = days.find(([stem]) =>
    current.toLowerCase().includes(stem),
  )?.[1];
  const wholeWeek = /недел|все дни/i.test(current);
  if (
    !explicit &&
    !group &&
    !(inSchedule && (relative || date || weekday || wholeWeek))
  )
    return null;
  const previous = recent
    .slice(0, -1)
    .reverse()
    .map((m) => normalizeGroup(m.content))
    .find(Boolean);
  return {
    group: group || (inSchedule ? previous : '') || '',
    day: wholeWeek ? '' : relative || date || weekday || '',
  };
}
export async function scheduleViaMcp(mcp, args, emit) {
  emit({ type: 'status', message: 'Открываю расписание группы…' });
  const result = await mcp.client.callTool(
    { name: 'get_group_schedule', arguments: args },
    undefined,
    { timeout: 60000 },
  );
  const data = JSON.parse(
    result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n'),
  );
  if (result.isError)
    throw new Error(data.error || 'Не удалось открыть расписание.');
  const sources = [
    { url: data.url, title: data.title, fetchedAt: data.fetchedAt },
  ];
  emit({
    type: 'tool',
    step: {
      name: 'get_group_schedule',
      arguments: args,
      status: 'done',
      detail: data.needsGroup
        ? 'Выбери группу'
        : `${data.lessons.length} занятий · группа ${data.group}`,
    },
  });
  emit({
    type: 'answer',
    content: data.formattedAnswer,
    sources,
    schedule: data,
  });
  return data;
}
