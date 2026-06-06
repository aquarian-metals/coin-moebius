export async function ensureScriptLoaded(
	src: string,
	globalName?: string,
	timeout = 10000,
): Promise<void> {
	if (globalName && (window as unknown as Record<string, unknown>)[globalName]) return;

	return new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = src;
		script.async = true;
		script.defer = true;

		const timer = setTimeout(() => {
			script.remove();
			reject(new Error(`Script load timeout: ${src}`));
		}, timeout);

		script.onload = () => {
			clearTimeout(timer);
			resolve();
		};
		script.onerror = () => {
			clearTimeout(timer);
			reject(new Error(`Failed to load script: ${src}`));
		};

		document.head.appendChild(script);
	});
}
