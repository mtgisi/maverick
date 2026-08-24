#!/usr/bin/env node
// MCP stdio adapter. Exposes server/tools/registry.js over MCP, nothing more.
//
// Tool definitions and implementations live in the registry; this file only translates
// between MCP's wire shape and tools/index.js. It holds no business logic on purpose, so
// the MCP path and the local agent loop can never disagree about what a tool does.
//
// Still spawned per turn by `claude -p` today. After the cutover nothing runs it in
// production, but it stays in the tree: it makes the registry drivable from a dev
// machine's `claude` CLI, which is the cheapest way to debug a tool by hand.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { TZ } = require('./config');
const registry = require('./tools/registry');
const { dispatch } = require('./tools');

const CONV = process.env.MAVERICK_CONVERSATION_ID || 'default';

const server = new Server({ name: 'maverick', version: '0.2.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: registry.TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.schema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const { result } = await dispatch(name, args, {
    conversationId: CONV,
    actor: 'model',
    surface: 'mcp',
    now: new Date(),
    tz: TZ,
  });
  return { content: [{ type: 'text', text: result }] };
});

(async () => { await server.connect(new StdioServerTransport()); })();
