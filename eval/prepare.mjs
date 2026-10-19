import { writeFile } from 'node:fs/promises';
import { connectMcp } from '../server/agent.mjs';
const mcp = await connectMcp();
const snapshots = {};
try {
  for (const [id, name, args] of [
    ['schedule', 'get_group_schedule', { group: '11-401', day: 'понедельник' }],
    ['about', 'read_kfu_page', { url: 'https://kpfu.ru/itis/pochemu-itis' }],
    [
      'scholarships',
      'read_kfu_page',
      { url: 'https://kpfu.ru/itis/obuchenie-v-itis/stipendialnye-programmy' },
    ],
  ]) {
    const result = await mcp.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 120000 },
    );
    snapshots[id] = {
      name,
      arguments: args,
      data: JSON.parse(
        result.content
          .filter((x) => x.type === 'text')
          .map((x) => x.text)
          .join('\n'),
      ),
      isError: !!result.isError,
    };
    console.log(id, result.isError ? 'error' : 'saved');
  }
} finally {
  await mcp.client.close();
}
await writeFile(
  new URL('snapshots.json', import.meta.url),
  JSON.stringify({ capturedAt: new Date().toISOString(), snapshots }, null, 2),
);
