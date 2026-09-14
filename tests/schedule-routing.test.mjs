import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleRequest,
  scheduleViaMcp,
} from '../server/schedule-request.mjs';
import { getGroupSchedule } from '../server/schedule.mjs';
test('routes timetable and day follow-ups without an LLM, but not unrelated questions', () => {
  assert.deepEqual(
    scheduleRequest([
      { role: 'user', content: 'Покажи расписание 11-401 на завтра' },
    ]),
    { group: '11-401', day: 'завтра' },
  );
  assert.deepEqual(
    scheduleRequest([
      { role: 'assistant', content: 'Расписание группы 11-401' },
      { role: 'user', content: 'А на пятницу?' },
    ]),
    { group: '11-401', day: 'пятница' },
  );
  assert.equal(
    scheduleRequest([
      { role: 'assistant', content: 'Расписание группы 11-401' },
      { role: 'user', content: 'Где находится институт?' },
    ]),
    null,
  );
  assert.deepEqual(scheduleRequest([{ role: 'user', content: 'Расписание' }]), {
    group: '',
    day: '',
  });
});
test('bundled schedule works without any network and includes full week for UI filtering', async () => {
  const result = await getGroupSchedule({
    group: '11-401',
    day: 'понедельник',
  });
  assert.equal(result.mode, 'snapshot');
  assert.ok(result.availableGroups.length >= 60);
  assert.ok(result.lessons.length > 0);
  assert.ok(result.weekLessons.length > result.lessons.length);
  assert.ok(result.lessons.every((l) => l.day === 'понедельник'));
});
test('direct timetable route uses MCP and emits structured data for the card', async () => {
  const events = [];
  const data = {
    group: '11-401',
    lessons: [],
    weekLessons: [],
    url: 'https://docs.google.com/',
    title: 'Расписание',
    formattedAnswer: 'Расписание группы 11-401',
  };
  const mcp = {
    client: {
      callTool: async (call) => {
        assert.equal(call.name, 'get_group_schedule');
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      },
    },
  };
  await scheduleViaMcp(mcp, { group: '11-401' }, (e) => events.push(e));
  assert.equal(events.at(-1).type, 'answer');
  assert.deepEqual(events.at(-1).schedule, data);
});
