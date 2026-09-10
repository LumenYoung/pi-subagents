import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildInProcessChildLaunch, type BuildInProcessChildLaunchInput } from "../../src/runs/shared/child-launch.ts";
import { getHostBuiltinToolNames } from "../../src/runs/shared/child-tool-plan.ts";
import type { ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";

// The default dependency is a test shim. Run this contract against a real SDK:
// PI_SDK_ROOT=/path/to/pi-coding-agent node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/child-tool-plan-sdk.test.ts
const sdkRoot = process.env.PI_SDK_ROOT;
const provider = fileURLToPath(new URL("../fixtures/explicit-extension-tools.ts", import.meta.url));
const extensionTools = ["compress", "decompress", "search_context", "acp_status", "fixture_lookup"];
const requestedTools = ["read", ...extensionTools];

describe("child tool plan with real Pi SDK", { skip: sdkRoot ? false : "set PI_SDK_ROOT to a real pi-coding-agent package directory" }, () => {
	let sdk: typeof import("@earendil-works/pi-coding-agent");
	let runtime: Awaited<ReturnType<typeof sdk.ModelRuntime.create>>;
	let home: string;
	let agentDir: string;
	let networkAttempts = 0;
	const previousEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
	const originalFetch = globalThis.fetch;
	const model = {
		id: "fixture", name: "Offline fixture", provider: "fixture", api: "openai-responses",
		baseUrl: "https://invalid.example/v1", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	before(async () => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-tool-plan-sdk-"));
		agentDir = path.join(home, ".pi", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_OFFLINE = "1";
		globalThis.fetch = async () => { networkAttempts++; throw new Error("Network forbidden in SDK fixture test"); };
		sdk = await import(pathToFileURL(path.join(sdkRoot!, "dist/index.js")).href);
		assert.notEqual((sdk as unknown as { __piSubagentsTestShim?: boolean }).__piSubagentsTestShim, true);
		runtime = await sdk.ModelRuntime.create({
			authPath: path.join(home, "auth.json"), modelsPath: path.join(home, "models.json"), modelsStorePath: path.join(home, "models-store.json"),
		});
	});

	after(() => {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (home) fs.rmSync(home, { recursive: true, force: true });
		assert.equal(networkAttempts, 0);
	});

	async function open(input: Partial<Pick<ChildSessionLaunch, "tools" | "excludeTools" | "extensionPaths" | "ambientExtensions" | "hooks">>) {
		let api: import("@earendil-works/pi-coding-agent").ExtensionAPI;
		const errors: Array<{ event: string; error: unknown }> = [];
		const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
		const loader = new sdk.DefaultResourceLoader({
			cwd: home, agentDir, settingsManager,
			noExtensions: !input.ambientExtensions, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: input.extensionPaths ?? [],
			extensionFactories: [...(input.hooks ?? []), (pi) => { api = pi; }],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await sdk.createAgentSession({
			cwd: home, agentDir, settingsManager, resourceLoader: loader,
			sessionManager: sdk.SessionManager.inMemory(home), modelRuntime: runtime,
			model: model as never, tools: input.tools, excludeTools: input.excludeTools,
		});
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
		assert.deepEqual(errors, []);
		return { session, api: api!, loader, errors, async close() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		} };
	}

	function launch(input: Partial<BuildInProcessChildLaunchInput> = {}) {
		return buildInProcessChildLaunch({
			host: "parent", cwd: home, childAgentName: "fixture", childIndex: 0,
			sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
			waitToolEnabled: false, tools: requestedTools, hostAvailableBuiltins: ["read"],
			...input,
		});
	}

	it("loads explicit child providers for both hosts, with or without the provider in the parent", async () => {
		for (const parentHasProvider of [false, true]) {
			const parent = await open({ tools: requestedTools, extensionPaths: parentHasProvider ? [provider] : [] });
			try {
				const hostAvailableBuiltins = getHostBuiltinToolNames(parent.api);
				assert.deepEqual(hostAvailableBuiltins, ["read"]);
				assert.equal(parent.api.getAllTools().some((tool) => tool.name === "compress"), parentHasProvider);
				for (const host of ["parent", "runner"] as const) {
					for (const providerInput of [{ extensions: [provider] }, { subagentOnlyExtensions: [provider] }, { tools: [...requestedTools, provider] }]) {
						const built = launch({ host, hostAvailableBuiltins, ...providerInput });
						const child = await open(built.session);
						try {
							assert.deepEqual(child.api.getActiveTools().sort(), [...requestedTools].sort());
							assert.deepEqual(built.toolPlan.unavailableHostBuiltins, []);
							assert.deepEqual(built.config.requiredTools, requestedTools);
							assert.equal(child.loader.getExtensions().extensions.filter((ext) => ext.path === provider).length, 1);
							const tool = child.session.agent.state.tools.find((tool) => tool.name === "acp_status")!;
							const result = await tool.execute("offline", {}, new AbortController().signal);
							assert.deepEqual(result.content, [{ type: "text", text: "fixture:acp_status" }]);
							await child.session.extensionRunner.emit({ type: "agent_start" });
							assert.equal(built.capture.toolDiagnostic(), undefined);
							assert.deepEqual(child.errors, []);
							child.api.setActiveTools([...requestedTools, "fixture_unrequested"]);
							assert.equal(child.api.getActiveTools().includes("fixture_unrequested"), false);
						} finally { await child.close(); }
					}
				}
			} finally { await parent.close(); }
		}
	});

	it("does not grant an ambient runner provider's tools without explicit names", async () => {
		const ambientDir = path.join(home, ".pi", "extensions");
		fs.mkdirSync(ambientDir, { recursive: true });
		const ambientPath = path.join(ambientDir, "ambient.js");
		fs.writeFileSync(ambientPath, `export default (pi) => pi.registerTool({
			name: "fixture_ambient", label: "ambient", description: "Ambient authorization fixture",
			parameters: { type: "object", properties: {} },
			async execute() { return { content: [{ type: "text", text: "ambient" }], details: {} }; }
		});`);
		try {
			const built = launch({ host: "runner", tools: ["read"] });
			const child = await open(built.session);
			try {
				assert.equal(child.loader.getExtensions().extensions.some((ext) => ext.path === ambientPath), true);
				child.api.setActiveTools(["read", "fixture_ambient"]);
				assert.deepEqual(child.api.getActiveTools(), ["read"]);
			} finally { await child.close(); }
		} finally { fs.rmSync(ambientPath); }
	});

	it("keeps missing-provider and typo requirements visible to the actual prompt runtime", async () => {
		for (const input of [{}, { tools: ["read", "compres"], subagentOnlyExtensions: [provider] }]) {
			const built = launch(input);
			const child = await open(built.session);
			try {
				const missing = "tools" in input ? ["compres"] : extensionTools;
				await child.session.extensionRunner.emit({ type: "agent_start" });
				assert.deepEqual(built.capture.toolDiagnostic()?.missing, missing);
				assert.equal(child.errors.length, 1);
				assert.equal(child.errors[0]!.event, "agent_start");
				assert.match(String(child.errors[0]!.error), /requested unavailable child tools/);
				assert.match(String(child.errors[0]!.error), /provider path/);
				assert.deepEqual(built.toolPlan.unavailableHostBuiltins, []);
			} finally { await child.close(); }
		}
	});

	it("enforces exclusions, ceilings, denyExtensions and path-only authorization in the SDK", async () => {
		for (const restriction of [
			{ input: { excludeTools: ["compress"] }, expected: requestedTools.filter((tool) => tool !== "compress") },
			{ input: { capabilityCeiling: { version: 1 as const, allowedTools: ["read", "acp_status"], sources: ["test"] } }, expected: ["read", "acp_status"] },
			{ input: { inherited: { capabilityCeiling: { version: 1 as const, denyExtensions: true, sources: ["parent"] } } }, expected: ["read"] },
			{ input: { tools: [provider] }, expected: [] },
			{ input: { tools: ["read", "grep"] }, expected: ["read"] },
		]) {
			const built = launch({ subagentOnlyExtensions: [provider], ...restriction.input });
			const child = await open(built.session);
			try {
				assert.deepEqual(child.api.getActiveTools().sort(), [...restriction.expected].sort());
				child.api.setActiveTools([...requestedTools, "fixture_unrequested", "grep"]);
				assert.deepEqual(child.api.getActiveTools().sort(), [...restriction.expected].sort());
				await child.session.extensionRunner.emit({ type: "agent_start" });
				assert.equal(built.capture.toolDiagnostic(), undefined);
				assert.deepEqual(child.errors, []);
				if (built.toolPlan.capabilityCeiling?.denyExtensions) {
					assert.equal(child.loader.getExtensions().extensions.some((ext) => ext.path === provider), false);
				}
			} finally { await child.close(); }
		}
	});
});
