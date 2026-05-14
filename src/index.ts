/**
 * pi-gemini-oauth
 *
 * Gemini OAuth for Pi via Gemini Code Assist API (cloudcode-pa.googleapis.com).
 *
 * Unlike the consumer Gemini API (generativelanguage.googleapis.com) which only
 * accepts API keys, the Code Assist endpoint accepts OAuth Bearer tokens from
 * user accounts with a Gemini/Google Cloud subscription.
 *
 * This mirrors how opencode-gemini-auth works:
 *   1. OAuth login via browser → tokens stored in auth.json
 *   2. Project resolution via loadCodeAssist / onboardUser
 *   3. Requests wrapped as { project, model, request } to cloudcode-pa.googleapis.com
 *   4. SSE responses unwrapped from { response: ... } envelope
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	calculateCost,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

// =============================================================================
// OAuth & API Constants
// =============================================================================

// OAuth credentials: hardcoded for this public OAuth client.
// These are the same values used by opencode-gemini-auth and GeminiCLI.
const CLIENT_ID =
	"681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "http://localhost:8085/oauth2callback";

const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com";

const AUTH_PORT = 8085;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

// Encoded refresh token separator (matches opencode-gemini-auth convention)
const REFRESH_SEPARATOR = "|";

// =============================================================================
// PKCE Helpers
// =============================================================================

async function generatePKCE(): Promise<{
	verifier: string;
	challenge: string;
}> {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	const verifier = btoa(String.fromCharCode(...array))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");

	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");

	return { verifier, challenge };
}

function generateState(): string {
	const array = new Uint8Array(16);
	crypto.getRandomValues(array);
	return btoa(String.fromCharCode(...array))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
}

// =============================================================================
// Refresh Token Encoding (store project ID alongside refresh token)
// =============================================================================

function encodeRefreshToken(refreshToken: string, projectId?: string): string {
	if (!projectId) return refreshToken;
	return `${refreshToken}${REFRESH_SEPARATOR}${projectId}`;
}

function decodeRefreshToken(encoded: string): {
	refreshToken: string;
	projectId?: string;
} {
	const parts = encoded.split(REFRESH_SEPARATOR);
	return {
		refreshToken: parts[0],
		projectId: parts[1] || undefined,
	};
}

// =============================================================================
// Project ID extraction helper
// cloudaicompanionProject can be a string or { id: string }
// =============================================================================

function extractProjectId(project: any): string | undefined {
	if (!project) return undefined;
	if (typeof project === "string") return project;
	if (typeof project === "object" && project.id) return project.id;
	return undefined;
}

// =============================================================================
// Project Management (Gemini Code Assist API)
// =============================================================================

async function loadCodeAssist(
	accessToken: string,
	projectId?: string,
): Promise<any> {
	const body: any = {
		metadata: {
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		},
	};
	if (projectId) {
		body.cloudaicompanionProject = projectId;
		body.metadata.duetProject = projectId;
	}

	const response = await fetch(`${CODE_ASSIST_URL}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "GeminiCLI/1.0 (linux; x64; terminal)",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		return null;
	}
	return response.json();
}

async function onboardUser(
	accessToken: string,
	projectId: string,
): Promise<string | undefined> {
	const body = {
		tierId: "legacy-tier",
		metadata: {
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
			duetProject: projectId,
		},
		cloudaicompanionProject: projectId,
	};

	const response = await fetch(`${CODE_ASSIST_URL}/v1internal:onboardUser`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "GeminiCLI/1.0 (linux; x64; terminal)",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) return undefined;

	let payload = await response.json();

	// Poll for long-running operation
	if (payload.name && !payload.done) {
		for (let attempt = 0; attempt < 10; attempt++) {
			await new Promise((r) => setTimeout(r, 5000));
			const opResponse = await fetch(
				`${CODE_ASSIST_URL}/v1internal/${payload.name}`,
				{
					headers: {
						Authorization: `Bearer ${accessToken}`,
					},
				},
			);
			if (opResponse.ok) {
				payload = await opResponse.json();
				if (payload.done) break;
			}
		}
	}

	if (payload.done) {
		const managedId = extractProjectId(
			payload.response?.cloudaicompanionProject,
		);
		if (managedId) return managedId;
		return projectId;
	}
	return undefined;
}

async function resolveProjectId(
	accessToken: string,
	existingEncodedRefresh?: string,
): Promise<string | undefined> {
	// First, try to extract from existing encoded refresh token
	if (existingEncodedRefresh) {
		const decoded = decodeRefreshToken(existingEncodedRefresh);
		if (decoded.projectId) {
			return decoded.projectId;
		}
	}

	// Otherwise, call loadCodeAssist to discover the project
	const loadResult = await loadCodeAssist(accessToken);

	// Check if a managed project was returned
	const managedProjectId = extractProjectId(
		loadResult?.cloudaicompanionProject,
	);
	if (managedProjectId) return managedProjectId;

	// Check current tier
	const currentTierId = loadResult?.currentTier?.id;
	if (currentTierId) {
		// User is onboarded but needs a project
		const projectId =
			extractProjectId(loadResult?.cloudaicompanionProject) ||
			process.env.GOOGLE_CLOUD_PROJECT ||
			process.env.GEMINI_PROJECT_ID;
		if (projectId) return projectId;
	}

	// Check allowed tiers for onboarding
	const allowedTiers = loadResult?.allowedTiers;
	if (allowedTiers && allowedTiers.length > 0) {
		const defaultTier =
			allowedTiers.find((t: any) => t.isDefault) || allowedTiers[0];
		const tierId = defaultTier?.id || "legacy-tier";

		// For free tier, no project needed
		if (tierId === "free-tier") {
			return "";
		}

		// For legacy/other tiers, we need a project
		const projectId =
			process.env.GOOGLE_CLOUD_PROJECT || process.env.GEMINI_PROJECT_ID;
		if (tierId !== "free-tier" && !projectId) {
			throw new Error(
				"Google Gemini requires a Google Cloud project. " +
					"Set GOOGLE_CLOUD_PROJECT or GEMINI_PROJECT_ID environment variable.",
			);
		}

		if (projectId && tierId !== "free-tier") {
			const onboardedId = await onboardUser(accessToken, projectId);
			if (onboardedId) return onboardedId;
			return projectId;
		}
	}

	return undefined;
}

// =============================================================================
// OAuth Flow Server
// =============================================================================

interface AuthCallback {
	code?: string;
	state?: string;
	error?: string;
}

async function startAuthServer(): Promise<AuthCallback> {
	return new Promise(async (resolve, reject) => {
		const { createServer } = await import("node:http");

		let timeout: ReturnType<typeof setTimeout>;
		let server: ReturnType<typeof createServer>;

		const cleanup = () => {
			clearTimeout(timeout);
			server.close();
		};

		timeout = setTimeout(() => {
			cleanup();
			reject(new Error("Authentication timeout"));
		}, AUTH_TIMEOUT_MS);

		server = createServer((req: any, res: any) => {
			const url = new URL(req.url || "", `http://localhost:${AUTH_PORT}`);

			if (url.pathname === "/oauth2callback" || url.pathname === "/") {
				const code = url.searchParams.get("code") ?? undefined;
				const state = url.searchParams.get("state") ?? undefined;
				const error = url.searchParams.get("error") ?? undefined;

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(
						"<html><body><h1>Authentication Failed</h1><p>You can close this window.</p></body></html>",
					);
					cleanup();
					resolve({ error });
				} else if (code) {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						"<html><body><h1>Authentication Successful!</h1><p>You can close this window and return to Pi.</p></body></html>",
					);
					cleanup();
					resolve({ code, state });
				} else {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(
						"<html><body><h1>Invalid Callback</h1><p>No authorization code received.</p></body></html>",
					);
				}
			} else {
				res.writeHead(404);
				res.end("Not found");
			}
		});

		server.listen(AUTH_PORT, "127.0.0.1", () => {
			// Server ready
		});

		server.on("error", (err: Error) => {
			cleanup();
			reject(err);
		});
	});
}

// =============================================================================
// OAuth Login (with project resolution)
// =============================================================================

async function loginGemini(
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const state = generateState();

	const authParams = new URLSearchParams({
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		response_type: "code",
		scope: SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		access_type: "offline",
		prompt: "consent",
	});

	const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;

	// Open browser for authentication
	callbacks.onAuth({ url: authUrl });

	// Start local server to receive callback
	const callback = await startAuthServer();

	if (callback.error) {
		throw new Error(`Authentication failed: ${callback.error}`);
	}

	if (!callback.code) {
		throw new Error("No authorization code received");
	}

	if (callback.state !== state) {
		throw new Error("State mismatch - possible CSRF attack");
	}

	// Build token exchange body (client_secret is optional for public clients)
	const tokenBody: Record<string, string> = {
		client_id: CLIENT_ID,
		code: callback.code,
		code_verifier: verifier,
		grant_type: "authorization_code",
		redirect_uri: REDIRECT_URI,
	};
	if (CLIENT_SECRET) {
		tokenBody.client_secret = CLIENT_SECRET;
	}

	const tokenResponse = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(tokenBody),
	});

	if (!tokenResponse.ok) {
		const errorText = await tokenResponse.text();
		throw new Error(`Token exchange failed: ${errorText}`);
	}

	const data = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
	};

	const refreshToken = data.refresh_token || "";
	const accessToken = data.access_token;
	const expiresIn = data.expires_in;

	// Resolve project ID using the access token
	let projectId: string | undefined;
	try {
		projectId = await resolveProjectId(accessToken);
	} catch {
		// If project resolution fails, proceed without project ID
		// The user can set GOOGLE_CLOUD_PROJECT later
	}

	// Encode project ID in refresh token for later use
	const encodedRefresh = encodeRefreshToken(refreshToken, projectId);

	return {
		access: accessToken,
		refresh: encodedRefresh,
		expires: Date.now() + (expiresIn - 60) * 1000,
	};
}

// =============================================================================
// Token Refresh
// =============================================================================

async function refreshGeminiToken(
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const { refreshToken, projectId } = decodeRefreshToken(credentials.refresh);

	if (!refreshToken) {
		throw new Error("No refresh token available");
	}

	// Build refresh body (client_secret is optional for public clients)
	const tokenBody: Record<string, string> = {
		client_id: CLIENT_ID,
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	};
	if (CLIENT_SECRET) {
		tokenBody.client_secret = CLIENT_SECRET;
	}

	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(tokenBody),
	});

	if (!response.ok) {
		throw new Error(`Token refresh failed: ${await response.text()}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		expires_in: number;
	};

	// Re-encode the project ID with the new (or same) refresh token
	const encodedRefresh = encodeRefreshToken(refreshToken, projectId);

	return {
		access: data.access_token,
		refresh: encodedRefresh,
		expires: Date.now() + (data.expires_in - 60) * 1000,
	};
}

// =============================================================================
// Message Conversion (Pi format -> Gemini/Code Assist format)
// =============================================================================

function convertMessagesToGemini(messages: any[]): any[] {
	const contents: any[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const parts: any[] = [];

			if (typeof msg.content === "string") {
				parts.push({ text: msg.content });
			} else if (Array.isArray(msg.content)) {
				for (const item of msg.content) {
					if (item.type === "text") {
						parts.push({ text: item.text });
					} else if (item.type === "image") {
						parts.push({
							inlineData: {
								mimeType: item.mimeType || "image/png",
								data: item.data,
							},
						});
					}
				}
			}

			if (parts.length > 0) {
				contents.push({ role: "user", parts });
			}

			// Handle tool results (they come as user role in Pi)
			if (Array.isArray(msg.content)) {
				for (const item of msg.content) {
					if (item.type === "toolResult") {
						contents.push({
							role: "user",
							parts: [
								{
									functionResponse: {
										name: item.name || "unknown",
										response: { result: item.content || "" },
									},
								},
							],
						});
					}
				}
			}
		} else if (msg.role === "assistant") {
			const parts: any[] = [];

			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "text" && block.text) {
						parts.push({ text: block.text });
					} else if (block.type === "toolCall") {
						// The Cloud Code Assist API expects a thoughtSignature
						// on functionCall parts that follow a thought/reasoning block.
						// Use the preserved signature if available from the API response,
						// otherwise use the synthetic skip value like opencode-gemini-auth.
						const signature =
							block.thoughtSignature || "skip_thought_signature_validator";
						parts.push({
							functionCall: {
								name: block.name,
								args: block.arguments || {},
							},
							thoughtSignature: signature,
						});
					}
					// NOTE: thinking blocks are intentionally stripped from history.
					// The Cloud Code Assist API rejects them in subsequent requests.
				}
			} else if (typeof msg.content === "string") {
				parts.push({ text: msg.content });
			}

			if (parts.length > 0) {
				contents.push({ role: "model", parts });
			}
		} else if (msg.role === "tool") {
			// Tool results as function responses
			const parts: any[] = [];
			const text =
				typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content.map((c: any) => c.text || "").join("")
						: "";

			parts.push({
				functionResponse: {
					name: msg.name || "unknown",
					response: { result: text },
				},
			});

			if (parts.length > 0) {
				contents.push({ role: "user", parts });
			}
		}
	}

	return contents;
}

// =============================================================================
// Tool Conversion (Pi format -> Gemini format)
// =============================================================================

function convertToolsToGemini(tools: any[]): any[] {
	if (!tools || tools.length === 0) return [];

	const geminiTools: any[] = [];
	const functionDeclarations: any[] = [];

	for (const tool of tools) {
		if (tool.type === "function" && tool.function) {
			const fn = tool.function;
			const declaration: any = {
				name: fn.name,
				description: fn.description || "",
			};

			if (fn.parameters) {
				declaration.parameters = convertSchemaToGemini(fn.parameters);
			}

			functionDeclarations.push(declaration);
		}
	}

	if (functionDeclarations.length > 0) {
		geminiTools.push({ functionDeclarations });
	}

	return geminiTools;
}

function convertSchemaToGemini(schema: any): any {
	if (!schema) return { type: "OBJECT" };

	const result: any = {};

	// Map JSON Schema types to Gemini types
	if (schema.type) {
		result.type = schema.type.toUpperCase();
	}

	if (schema.description) {
		result.description = schema.description;
	}

	if (schema.properties) {
		result.properties = {};
		result.required = schema.required || [];
		for (const [key, val] of Object.entries(schema.properties)) {
			result.properties[key] = convertSchemaToGemini(val as any);
		}
	}

	if (schema.items) {
		result.items = convertSchemaToGemini(schema.items);
	}

	if (schema.enum) {
		result.enum = schema.enum;
	}

	if (schema.type === "array" && !result.type) {
		result.type = "ARRAY";
	}

	return result;
}

// =============================================================================
// Project ID Resolution from stored auth.json
// =============================================================================

async function resolveProjectIdFromAuth(accessToken: string): Promise<string> {
	// 1. Check environment variables (fastest)
	const envProject =
		process.env.GOOGLE_CLOUD_PROJECT || process.env.GEMINI_PROJECT_ID;
	if (envProject) return envProject;

	// 2. Try to decode from auth.json (stored during login)
	try {
		const { readFile } = await import("node:fs/promises");
		const authPath = process.env.HOME
			? `${process.env.HOME}/.pi/agent/auth.json`
			: "/root/.pi/agent/auth.json";
		const authContent = await readFile(authPath, "utf-8");
		const auth = JSON.parse(authContent);

		// Check both provider names we might have stored under
		for (const key of ["google", "google-gemini"]) {
			const entry = auth[key];
			if (entry?.type === "oauth" && entry.refresh) {
				const decoded = decodeRefreshToken(entry.refresh);
				if (decoded.projectId) return decoded.projectId;
			}
		}
	} catch {
		// auth.json not accessible
	}

	// 3. Call loadCodeAssist to discover project
	try {
		const loadResult = await loadCodeAssist(accessToken);
		const managedId = extractProjectId(loadResult?.cloudaicompanionProject);
		if (managedId) return managedId;
	} catch {
		// Project discovery failed
	}

	// 4. Return empty (might work for free tier, will fail gracefully for others)
	return "";
}

// =============================================================================
// Streaming Implementation (via Cloud Code Assist API)
// =============================================================================

function streamGemini(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const accessToken = options?.apiKey ?? "";
			if (!accessToken) {
				throw new Error(
					"No OAuth token available. Run /login and authenticate with Google Gemini (OAuth).",
				);
			}

			// Resolve project ID: check env vars first, then decode from stored auth
			const projectId = await resolveProjectIdFromAuth(accessToken);

			// Convert messages
			const contents = convertMessagesToGemini(context.messages);

			// Build the inner Gemini request payload
			const requestPayload: any = {
				contents,
				generationConfig: {
					maxOutputTokens: options?.maxTokens || model.maxTokens,
				},
			};

			// Add system prompt
			if (context.systemPrompt) {
				requestPayload.systemInstruction = {
					parts: [{ text: context.systemPrompt }],
				};
			}

			// Add thinking config
			if (options?.reasoning && model.reasoning) {
				requestPayload.generationConfig.thinkingConfig = {
					thinkingBudget: 8192,
					includeThoughts: true,
				};
			}

			// Add tools
			if (context.tools && context.tools.length > 0) {
				const geminiTools = convertToolsToGemini(context.tools);
				if (geminiTools.length > 0) {
					requestPayload.tools = geminiTools;
				}
			}

			// Build the wrapped request for Cloud Code Assist API
			const wrappedBody: any = {
				project: projectId,
				model: model.id,
				request: requestPayload,
			};

			const url = `${CODE_ASSIST_URL}/v1internal:streamGenerateContent?alt=sse`;

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
				Accept: "text/event-stream",
				"User-Agent": "GeminiCLI/1.0 (linux; x64; terminal)",
			};

			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(wrappedBody),
				signal: options?.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				let parsedError: any;
				try {
					parsedError = JSON.parse(errorText);
					// Check if this is a wrapped error response
					if (parsedError.response?.error) {
						const msg = parsedError.response.error.message || "Unknown error";
						throw new Error(`Gemini API error: ${response.status} - ${msg}`);
					}
				} catch (e) {
					if (e instanceof Error && e.message.startsWith("Gemini API error")) {
						throw e;
					}
				}
				throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			stream.push({ type: "start", partial: output });

			// Parse SSE stream, unwrapping { response: ... } envelope
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith("data: ")) continue;

					const jsonStr = trimmed.slice(6).trim();
					if (jsonStr === "[DONE]") continue;

					processLine(jsonStr, model, output, stream);
				}
			}

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage =
				error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

/**
 * Process a single SSE data line, unwrapping from { response: ... } envelope.
 */
function processLine(
	jsonStr: string,
	model: Model<Api>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	try {
		let data = JSON.parse(jsonStr);

		// Unwrap from Cloud Code Assist envelope: { response: { candidates: [...], usageMetadata: {...} } }
		if (data.response) {
			data = data.response;
		}

		// Process usage metadata
		if (data.usageMetadata) {
			output.usage.input = data.usageMetadata.promptTokenCount || 0;
			output.usage.output = data.usageMetadata.candidatesTokenCount || 0;
			output.usage.totalTokens = data.usageMetadata.totalTokenCount || 0;
			calculateCost(model, output.usage);
		}

		// Process candidates
		const candidate = data.candidates?.[0];
		if (!candidate?.content?.parts) return;

		for (const part of candidate.content.parts) {
			// Handle thinking parts (reasoning/thought blocks with signature)
			if (part.thought || part.thinking) {
				const thinkingText = part.text || part.thinking || "";
				const existingThinking = output.content.find(
					(c: any) => c.type === "thinking",
				);
				if (existingThinking) {
					existingThinking.thinking += thinkingText;
				} else {
					output.content.push({
						type: "thinking",
						thinking: thinkingText,
						thinkingSignature:
							part.thinkingSignature || part.thoughtSignature || "",
					});
				}
				continue;
			}

			if (part.text) {
				const existingText = output.content.find((c: any) => c.type === "text");
				if (existingText) {
					existingText.text += part.text;
					stream.push({
						type: "text_delta",
						contentIndex: output.content.indexOf(existingText),
						delta: part.text,
						partial: output,
					});
				} else {
					output.content.push({ type: "text", text: part.text });
					const idx = output.content.length - 1;
					stream.push({
						type: "text_start",
						contentIndex: idx,
						partial: output,
					});
					stream.push({
						type: "text_delta",
						contentIndex: idx,
						delta: part.text,
						partial: output,
					});
					stream.push({
						type: "text_end",
						contentIndex: idx,
						content: part.text,
						partial: output,
					});
				}
			} else if (part.functionCall) {
				const fc = part.functionCall;
				const toolCallId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
				// Preserve the thoughtSignature if the API returned one.
				// This will be used when sending back to the API
				// (falls back to "skip_thought_signature_validator" in convertMessagesToGemini).
				const fcSignature =
					fc.thoughtSignature ||
					fc.thought_signature ||
					part.thoughtSignature ||
					"";
				output.content.push({
					type: "toolCall",
					id: toolCallId,
					name: fc.name,
					arguments: fc.args || {},
					thoughtSignature: fcSignature,
				});
				const idx = output.content.length - 1;
				stream.push({
					type: "toolcall_start",
					contentIndex: idx,
					partial: output,
				});
				stream.push({
					type: "toolcall_delta",
					contentIndex: idx,
					delta: JSON.stringify(fc.args || {}),
					partial: output,
				});
				stream.push({
					type: "toolcall_end",
					contentIndex: idx,
					toolCall: output.content[idx],
					partial: output,
				});
			}
		}

		// Process finish reason
		if (candidate.finishReason) {
			const finishMap: Record<string, "stop" | "length" | "toolUse"> = {
				STOP: "stop",
				MAX_TOKENS: "length",
				TOOL_CALLS: "toolUse",
				FINISH_REASON_STOP: "stop",
				FINISH_REASON_MAX_TOKENS: "length",
				FINISH_REASON_TOOL_CALLS: "toolUse",
			};
			output.stopReason = finishMap[candidate.finishReason] || "stop";
		}
	} catch (e) {
		// Skip malformed JSON
	}
}

// =============================================================================
// Gemini Models (standard Google model IDs for Code Assist)
// =============================================================================

function getGeminiModels() {
	return [
		{
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		},
		{
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 64000,
		},
		{
			id: "gemini-2.5-flash-lite",
			name: "Gemini 2.5 Flash Lite",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		},
		{
			id: "gemini-3-flash-preview",
			name: "Gemini 3 Flash (Preview)",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 16384,
		},
		{
			id: "gemini-3.1-pro-preview",
			name: "Gemini 3.1 Pro (Preview)",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		},
	];
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	// Register as "google" provider to override Pi's built-in Google provider.
	// This makes models appear as google/gemini-... and integrates with Pi's
	// model selection (/model) and login (/login) systems.
	pi.registerProvider("google", {
		name: "Google Gemini (OAuth)",
		baseUrl: CODE_ASSIST_URL,
		api: "google-generative-ai",
		apiKey: "GOOGLE_API_KEY", // Fallback env var (not used with OAuth)

		models: getGeminiModels(),

		oauth: {
			name: "Google Gemini (OAuth)",
			login: loginGemini,
			refreshToken: refreshGeminiToken,
			getApiKey: (cred: OAuthCredentials) => cred.access,
		},

		// Custom streaming implementation that routes through Cloud Code Assist
		streamSimple: streamGemini,
	});

	pi.on("session_start", async () => {
		// Provider is registered - it will appear in /login menu
	});
}
