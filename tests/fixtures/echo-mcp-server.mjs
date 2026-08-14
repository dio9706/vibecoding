// 最小 stdio MCP server（测试夹具）：一个 echo 工具。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '0.0.1' });
server.tool('echo', 'echo back text', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: 'ECHO:' + text }],
}));
server.tool('boom', 'always errors', {}, async () => ({
  content: [{ type: 'text', text: 'kaboom' }],
  isError: true,
}));
await server.connect(new StdioServerTransport());
