import { writeFile } from 'node:fs/promises';
import { loadSchedule, SCHEDULE_URL } from '../server/schedule.mjs';
const data = await loadSchedule(true);
await writeFile(
  new URL('../server/data/timetable.json', import.meta.url),
  JSON.stringify(
    { ...data, sourceUrl: SCHEDULE_URL, mode: 'snapshot' },
    null,
    2,
  ) + '\n',
);
console.log(
  `Saved ${data.groups.length} groups, fetched ${data.fetchedAt}. Restart the app to use this snapshot.`,
);
