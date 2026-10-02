// Bundles the agent into one ES module that the Worker serves to new CVMs at /agent/agent.mjs.
import { build } from "esbuild";

await build({
	entryPoints: ["src/main.ts"],
	outfile: "../worker/public/agent/agent.mjs",
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	minify: true,
	sourcemap: false,
	legalComments: "none",
	// Some bundled CommonJS dependencies call require() for Node built-ins.
	banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
	logLevel: "info",
});
