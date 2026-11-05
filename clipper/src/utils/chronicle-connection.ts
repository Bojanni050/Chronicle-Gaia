import { generalSettings, saveSettings } from './storage-utils';

/**
 * Resolves where clips go and with which token, without asking the user.
 *
 * Chronicle's local listener exposes GET /ingest/config for browser
 * extensions (services/ingest-listener.js): loopback-only, extension origins
 * only, no CORS headers. This module calls it on demand and keeps the result
 * in memory for the rest of the browser session — the token is deliberately
 * not written to storage, because general_settings lives in storage.sync and
 * an ingest token is per-machine.
 *
 * If the app is not running, the caller gets a message that says so instead
 * of a 401.
 */

export interface ChronicleConnection {
	baseUrl: string;
	token: string;
}

const DEFAULT_URL = 'http://127.0.0.1:4580';

let cached: ChronicleConnection | null = null;

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, '');
}

function candidateUrls(): string[] {
	const configured = normalizeBaseUrl(generalSettings.chronicleUrl || '');
	const urls: string[] = [];
	if (configured) urls.push(configured);
	if (!urls.includes(DEFAULT_URL)) urls.push(DEFAULT_URL);
	return urls;
}

async function fetchConfig(baseUrl: string): Promise<ChronicleConnection> {
	const response = await fetch(`${baseUrl}/ingest/config`, {
		method: 'GET',
		headers: { Accept: 'application/json' },
		cache: 'no-store',
	});
	if (!response.ok) {
		throw new Error(`Chronicle gaf status ${response.status}`);
	}
	const body = await response.json().catch(() => null) as { token?: unknown; listenerUrl?: unknown } | null;
	if (!body || typeof body.token !== 'string' || !body.token) {
		throw new Error('Chronicle stuurde geen ingest-token terug');
	}
	const listenerUrl = typeof body.listenerUrl === 'string' && body.listenerUrl.trim()
		? normalizeBaseUrl(body.listenerUrl)
		: baseUrl;
	return { baseUrl: listenerUrl, token: body.token };
}

/**
 * Returns the listener URL and token, asking Chronicle once per session.
 * `force` bypasses the cache — used after a 401, when the app restarted with
 * a new token.
 */
export async function resolveChronicleConnection(options: { force?: boolean } = {}): Promise<ChronicleConnection> {
	if (cached && !options.force) return cached;

	const failures: string[] = [];
	for (const baseUrl of candidateUrls()) {
		try {
			const connection = await fetchConfig(baseUrl);
			cached = connection;
			if (generalSettings.chronicleUrl !== connection.baseUrl) {
				await saveSettings({ chronicleUrl: connection.baseUrl });
			}
			return connection;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			failures.push(`${baseUrl} (${reason})`);
		}
	}

	cached = null;
	throw new Error(
		`Chronicle is niet bereikbaar — draait de app? Geprobeerd: ${failures.join(', ')}`,
	);
}

/** Drops the cached token so the next resolve asks the app again. */
export function clearChronicleConnection(): void {
	cached = null;
}
