#!/usr/bin/env node
// taskherd-mcp — MCP server exposing the tasks_* tools over stdio (DESIGN §16).
// Targets the repo at its launch cwd (or TASKHERD_REPO, set by the executor for
// scheduled runs so worktree-cwd agents still hit the main repo's .tasks/).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTaskherdServer } from '../src/mcp.mjs';

const server = createTaskherdServer({ cwd: process.cwd(), env: process.env });
await server.connect(new StdioServerTransport());
