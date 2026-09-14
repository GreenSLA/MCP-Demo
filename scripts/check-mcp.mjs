import { connectMcp } from '../server/agent.mjs';
const mcp = await connectMcp();
try {
  console.log(
    'MCP tools:',
    mcp.tools.map((t) => t.function.name),
  );
  const response = await mcp.client.callTool(
    {
      name: 'search_kfu',
      arguments: {
        query: process.argv.slice(2).join(' ') || 'контакты адрес телефон ИТИС',
        limit: 3,
      },
    },
    undefined,
    { timeout: 120000 },
  );
  const data = JSON.parse(response.content[0].text);
  console.log(JSON.stringify(data, null, 2));
  if (response.isError || !data.results?.length) process.exitCode = 1;
} finally {
  await mcp.client.close();
}
