import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ACP-like names exercise generic authorization without loading ACP itself.
export default function registerFixtureTools(pi: ExtensionAPI): void {
	for (const name of ["compress", "decompress", "search_context", "acp_status", "fixture_lookup", "fixture_unrequested"]) {
		pi.registerTool({
			name,
			label: name,
			description: "Offline child tool authorization fixture",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: `fixture:${name}` }], details: {} };
			},
		});
	}
}
