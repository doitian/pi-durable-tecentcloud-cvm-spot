/**
 * Polls the CVM metadata service for a spot reclaim notice. The endpoint answers 404 until a reclaim is scheduled,
 * then the termination time as `YYYY-MM-DD HH:mm:ss` in UTC+8.
 */
export function watchSpotTermination(
	metadataUrl: string,
	pollMs: number,
	onNotice: (terminationTime: Date, raw: string) => void,
): () => void {
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	const poll = async () => {
		try {
			const response = await fetch(`${metadataUrl}/spot/termination-time`, { signal: AbortSignal.timeout(3000) });
			if (response.ok) {
				const raw = (await response.text()).trim();
				const time = parseTerminationTime(raw);
				if (time) {
					stopped = true;
					onNotice(time, raw);
					return;
				}
			}
		} catch {
			// Metadata is unreachable outside Tencent Cloud.
		}
		if (!stopped) timer = setTimeout(poll, pollMs);
	};
	void poll();
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}

export function parseTerminationTime(raw: string): Date | undefined {
	const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(raw);
	if (!match) return undefined;
	const time = new Date(`${match[1]}T${match[2]}+08:00`);
	return Number.isNaN(time.getTime()) ? undefined : time;
}
