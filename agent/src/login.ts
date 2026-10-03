import { randomUUID } from "node:crypto";
import type { AuthInteraction, AuthPrompt, CredentialStore } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { AuthProviderInfo, AuthReport, LoginMessage, LoginPrompt } from "../../shared/protocol.ts";

interface ActiveLogin {
	abort: AbortController;
	prompts: Map<string, { resolve(value: string): void; reject(error: Error): void }>;
}

/**
 * Runs pi-ai login flows on behalf of the control panel: events and prompts go to the browser, answers come back.
 * Credentials end up in the store, which the Hub keeps.
 */
export class LoginManager {
	private readonly active = new Map<string, ActiveLogin>();

	constructor(
		private readonly models: MutableModels,
		private readonly store: CredentialStore,
		private readonly send: (message: LoginMessage) => void,
		private readonly getDeviceId: () => Promise<string>,
		private readonly onChange: () => void,
	) {}

	async report(): Promise<AuthReport> {
		const names = new Map(this.models.getProviders().map((provider) => [provider.id, provider.name]));
		const available = await this.models.getAvailable().catch(() => []);
		return {
			providers: await this.providers(),
			models: available.map((model) => ({
				provider: model.provider,
				providerName: names.get(model.provider) ?? model.provider,
				id: model.id,
				name: model.name,
			})),
		};
	}

	private async providers(): Promise<AuthProviderInfo[]> {
		const stored = new Map((await this.store.list()).map((info) => [info.providerId, info.type]));
		return Promise.all(
			this.models.getProviders().map(async (provider): Promise<AuthProviderInfo> => {
				const check = await this.models.checkAuth(provider.id).catch(() => undefined);
				const oauth = provider.auth.oauth;
				return {
					id: provider.id,
					name: provider.name,
					...(oauth ? { oauth: { name: oauth.loginLabel ?? oauth.name, subscription: !!oauth.isSubscription } } : {}),
					apiKeyLogin: !!provider.auth.apiKey?.login,
					...(check ? { configured: { type: check.type, ...(check.source ? { source: check.source } : {}) } } : {}),
					...(stored.has(provider.id) ? { stored: stored.get(provider.id)! } : {}),
				};
			}),
		);
	}

	async start(loginId: string, provider: string, type: "oauth" | "api_key"): Promise<void> {
		const login: ActiveLogin = { abort: new AbortController(), prompts: new Map() };
		this.active.set(loginId, login);
		const interaction: AuthInteraction = {
			signal: login.abort.signal,
			notify: (event) => {
				const { type } = event;
				if (type === "device_code") {
					this.send({
						t: "login_event",
						loginId,
						event: {
							type,
							userCode: event.userCode,
							verificationUri: event.verificationUri,
							...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}),
						},
					});
				} else if (type === "info") {
					this.send({ t: "login_event", loginId, event: { type, message: event.message, ...(event.links ? { links: [...event.links] } : {}) } });
				} else {
					this.send({ t: "login_event", loginId, event: { ...event } });
				}
			},
			prompt: (prompt) => this.ask(loginId, login, prompt),
		};
		try {
			const deviceId = await this.getDeviceId();
			await this.models.login(provider, type, interaction, { getDeviceId: () => deviceId });
			this.send({ t: "login_done", loginId, ok: true });
		} catch (error) {
			const message = login.abort.signal.aborted ? "cancelled" : error instanceof Error ? error.message : String(error);
			this.send({ t: "login_done", loginId, ok: false, error: message });
		} finally {
			this.active.delete(loginId);
			this.onChange();
		}
	}

	private ask(loginId: string, login: ActiveLogin, prompt: AuthPrompt): Promise<string> {
		const promptId = randomUUID();
		const { signal, ...shown } = prompt;
		return new Promise<string>((resolve, reject) => {
			const close = (error: Error) => {
				if (!login.prompts.delete(promptId)) return;
				this.send({ t: "login_prompt_closed", loginId, promptId });
				reject(error);
			};
			// A flow can withdraw a prompt, e.g. when its callback server received the code first.
			signal?.addEventListener("abort", () => close(new Error("prompt withdrawn")), { once: true });
			login.abort.signal.addEventListener("abort", () => close(new Error("cancelled")), { once: true });
			login.prompts.set(promptId, {
				resolve: (value) => {
					login.prompts.delete(promptId);
					resolve(value);
				},
				reject: close,
			});
			this.send({ t: "login_prompt", loginId, promptId, prompt: shown as LoginPrompt });
		});
	}

	reply(loginId: string, promptId: string, value: string): void {
		this.active.get(loginId)?.prompts.get(promptId)?.resolve(value);
	}

	cancel(loginId: string): void {
		this.active.get(loginId)?.abort.abort();
	}

	async logout(provider: string): Promise<void> {
		await this.models.logout(provider);
		this.onChange();
	}
}
