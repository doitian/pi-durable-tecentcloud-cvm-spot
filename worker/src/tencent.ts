// Minimal Tencent Cloud API 3.0 client for Workers: TC3-HMAC-SHA256 signing over Web Crypto.

const encoder = new TextEncoder();
const CONTENT_TYPE = "application/json; charset=utf-8";

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

export interface SignInput {
	secretId: string;
	secretKey: string;
	service: string;
	host: string;
	payload: string;
	/** Unix seconds. */
	timestamp: number;
}

/** Returns the `Authorization` header value for a POST with a JSON body. */
export async function signTc3(input: SignInput): Promise<string> {
	const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
	const signedHeaders = "content-type;host";
	const canonicalRequest = [
		"POST",
		"/",
		"",
		`content-type:${CONTENT_TYPE}\nhost:${input.host}\n`,
		signedHeaders,
		await sha256Hex(input.payload),
	].join("\n");
	const scope = `${date}/${input.service}/tc3_request`;
	const stringToSign = ["TC3-HMAC-SHA256", input.timestamp, scope, await sha256Hex(canonicalRequest)].join("\n");
	const secretDate = await hmac(encoder.encode(`TC3${input.secretKey}`), date);
	const secretService = await hmac(secretDate, input.service);
	const secretSigning = await hmac(secretService, "tc3_request");
	const signature = hex(await hmac(secretSigning, stringToSign));
	return `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export class TencentApiError extends Error {
	constructor(
		readonly action: string,
		readonly code: string,
		message: string,
		readonly requestId?: string,
	) {
		super(`${action}: ${code}: ${message}`);
		this.name = "TencentApiError";
	}
}

export interface TencentCredentials {
	secretId: string;
	secretKey: string;
}

export class TencentCloud {
	/**
	 * @param endpoint URL template with a `{service}` placeholder; defaults to the public API. Overridden only to
	 *   point the Hub at a simulator.
	 */
	constructor(
		private readonly credentials: TencentCredentials,
		readonly region: string,
		private readonly endpoint = "https://{service}.tencentcloudapi.com/",
	) {}

	async call<T = Record<string, unknown>>(
		service: string,
		version: string,
		action: string,
		params: Record<string, unknown> = {},
	): Promise<T> {
		const url = this.endpoint.replaceAll("{service}", service);
		const host = new URL(url).host;
		const payload = JSON.stringify(params);
		const timestamp = Math.floor(Date.now() / 1000);
		const authorization = await signTc3({ ...this.credentials, service, host, payload, timestamp });
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: authorization,
				"Content-Type": CONTENT_TYPE,
				"X-TC-Action": action,
				"X-TC-Version": version,
				"X-TC-Timestamp": String(timestamp),
				"X-TC-Region": this.region,
				"X-TC-Language": "en-US",
			},
			body: payload,
		});
		const body = (await response.json()) as { Response?: T & { Error?: { Code: string; Message: string }; RequestId?: string } };
		const result = body.Response;
		if (!result) throw new TencentApiError(action, `HTTP${response.status}`, "missing Response");
		if (result.Error) throw new TencentApiError(action, result.Error.Code, result.Error.Message, result.RequestId);
		return result;
	}

	cvm<T = Record<string, unknown>>(action: string, params?: Record<string, unknown>): Promise<T> {
		return this.call<T>("cvm", "2017-03-12", action, params);
	}

	cbs<T = Record<string, unknown>>(action: string, params?: Record<string, unknown>): Promise<T> {
		return this.call<T>("cbs", "2017-03-12", action, params);
	}

	vpc<T = Record<string, unknown>>(action: string, params?: Record<string, unknown>): Promise<T> {
		return this.call<T>("vpc", "2017-03-12", action, params);
	}
}
