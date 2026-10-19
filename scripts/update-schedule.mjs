import { loadSchedule } from '../server/schedule.mjs';
const data = await loadSchedule(true, { strict: true });
console.log(
  `Updated cache: ${data.groups.length} groups, fetched ${data.fetchedAt}. The running app refreshes automatically within 5 minutes (or use the refresh button).`,
);
