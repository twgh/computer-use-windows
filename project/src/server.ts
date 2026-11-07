import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createComputerUseMcpServer } from './vendor/computer-use-mcp/mcpServer.js'
import { createComputerUseRuntime } from './runtime.js'
import { logDebug } from './lib/log.js'

export async function runServer(): Promise<void> {
  const runtime = await createComputerUseRuntime()
  // `context` is deliberately omitted: the runtime already bound the process's
  // single dispatcher, and the factory must reuse it instead of binding a
  // second one. Two bindings would mean two last-screenshot cells — the click
  // after a screenshot taken through the other entry point would be rejected
  // as "outside the last screenshot image".
  const server = createComputerUseMcpServer(
    runtime.adapter,
    runtime.coordinateMode,
    undefined,
    runtime.tools,
    runtime.invokeRaw,
  )
  const transport = new StdioServerTransport()
  logDebug('starting stdio MCP server')
  await server.connect(transport)
}
