import { describe, expect, it } from "vitest";
// The official SDK's signer is the reference implementation.
import signModule from "tencentcloud-sdk-nodejs-common/tencentcloud/common/sign.js";
import { signTc3 } from "../src/tencent.ts";

// CommonJS module with `exports.default = Sign`.
const Sign = (signModule as unknown as { default: typeof signModule }).default ?? signModule;

describe("signTc3", () => {
	it("matches the Tencent Cloud SDK signature", async () => {
		const secretId = "AKIDEXAMPLE0123456789";
		const secretKey = "secret-key-example-0123456789abcdef";
		const timestamp = 1_790_000_000;
		const params = { Filters: [{ Name: "zone", Values: ["ap-singapore-3"] }], Limit: 20 };
		const expected = Sign.sign3({
			method: "POST",
			url: "https://cvm.tencentcloudapi.com/",
			payload: params,
			timestamp,
			service: "cvm",
			secretId,
			secretKey,
			headers: { "Content-Type": "application/json; charset=utf-8" },
		});
		const actual = await signTc3({
			secretId,
			secretKey,
			service: "cvm",
			host: "cvm.tencentcloudapi.com",
			payload: JSON.stringify(params),
			timestamp,
		});
		expect(actual).toBe(expected);
	});
});
