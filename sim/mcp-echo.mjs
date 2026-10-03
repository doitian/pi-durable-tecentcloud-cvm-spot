// A minimal stdio MCP server for tests: `echo` returns its text, prefixed with ECHO_PREFIX from its environment.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "echo",
			description: "Return the text unchanged",
			inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		},
		{ name: "secret-tool", description: "Hidden by the test configuration", inputSchema: { type: "object" } },
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name !== "echo") return { content: [{ type: "text", text: "unknown tool" }], isError: true };
	return { content: [{ type: "text", text: `${process.env.ECHO_PREFIX ?? ""}${request.params.arguments?.text ?? ""}` }] };
});

await server.connect(new StdioServerTransport());
