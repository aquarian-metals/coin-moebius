// W4: dedupe concurrent + repeat loads. Two near-simultaneous calls (or a
// second call before the first finishes) used to each append their own
// <script>, double-loading the provider SDK. We memoize the in-flight/settled
// promise per `src` and reuse an existing tag, so a given script is fetched at
// most once per page.
const loads = new Map<string, Promise<void>>();

export function ensureScriptLoaded(
	src: string,
	globalName?: string,
	timeout = 10000,
): Promise<void> {
	// Already present on `window` (e.g. loaded by the page itself) — nothing to do.
	if (globalName && (window as unknown as Record<string, unknown>)[globalName]) {
		return Promise.resolve();
	}

	const existing = loads.get(src);
	if (existing) return existing;

	const promise = new Promise<void>((resolve, reject) => {
		// A matching tag may already exist (a prior call, or the page's own
		// markup). Reuse it instead of appending a duplicate.
		const current = document.querySelector<HTMLScriptElement>(`script[src="${CSS.escape(src)}"]`);
		const script = current ?? document.createElement('script');
		const isNew = current === null;
		if (isNew) {
			script.src = src;
			script.async = true;
			script.defer = true;
		}

		const timer = setTimeout(() => {
			if (isNew) script.remove();
			reject(new Error(`Script load timeout: ${src}`));
		}, timeout);

		script.addEventListener('load', () => {
			clearTimeout(timer);
			resolve();
		});
		script.addEventListener('error', () => {
			clearTimeout(timer);
			reject(new Error(`Failed to load script: ${src}`));
		});

		if (isNew) document.head.appendChild(script);
	});

	// Drop a failed load from the cache so a later call can retry; a successful
	// load stays memoized.
	const tracked = promise.catch((err) => {
		loads.delete(src);
		throw err;
	});
	loads.set(src, tracked);
	return tracked;
}
