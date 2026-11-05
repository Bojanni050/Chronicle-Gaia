import { incrementStat } from './storage-utils';
import { clearChronicleConnection, resolveChronicleConnection, ChronicleConnection } from './chronicle-connection';

/**
 * Sends a clip to Chronicle's local ingest listener instead of Obsidian.
 * Mirrors saveToObsidian()'s role (obsidian-note-creator.ts) but POSTs
 * directly — Chronicle runs a loopback-only HTTP door
 * (services/ingest-listener.js in the Chronicle-Gaia repo), so there is no
 * URI scheme or clipboard hand-off involved, just one request.
 *
 * The listener URL and token come from GET /ingest/config (see
 * chronicle-connection.ts); the user does not configure a token by hand. A
 * 401 means Chronicle restarted with a different token, so the cached
 * connection is dropped and the request is retried once.
 *
 * fileContent already includes the frontmatter the popup generated
 * (generateFrontmatter + the note content field); Chronicle stores it
 * verbatim as the chat/note's Markdown content, same as it does for a
 * provider-sourced chat.
 */
export async function saveToChronicle(
	fileContent: string,
	noteName: string,
	url: string,
): Promise<void> {
	const payload = {
		content: fileContent,
		title: noteName || url,
		url,
		// Chronicle's own object kind: a clip is a web object, not a chat.
		// `source` is where it came from (the page), shown as the sitenaam.
		object: 'web',
		source: url || undefined,
		sourceProvider: 'web',
		occurredAt: new Date().toISOString(),
	};

	let connection = await resolveChronicleConnection();
	let response = await post(connection, payload);

	if (response.status === 401) {
		clearChronicleConnection();
		connection = await resolveChronicleConnection({ force: true });
		response = await post(connection, payload);
	}

	const body = await response.json().catch(() => ({} as any));
	if (!response.ok) {
		throw new Error(body.error || `Chronicle gaf status ${response.status}`);
	}

	await incrementStat('addToObsidian');
}

function post(connection: ChronicleConnection, payload: unknown): Promise<Response> {
	return fetch(`${connection.baseUrl}/ingest/chat`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${connection.token}`,
		},
		body: JSON.stringify(payload),
	});
}
