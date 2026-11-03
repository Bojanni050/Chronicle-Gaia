import { generalSettings, incrementStat } from './storage-utils';

/**
 * Sends a clip to Chronicle's local ingest listener instead of Obsidian.
 * Mirrors saveToObsidian()'s role (obsidian-note-creator.ts) but POSTs
 * directly — Chronicle runs a loopback-only HTTP door
 * (services/ingest-listener.js in the Chronicle-Gaia repo), so there is no
 * URI scheme or clipboard hand-off involved, just one request.
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
	const baseUrl = (generalSettings.chronicleUrl || 'http://127.0.0.1:4580').replace(/\/$/, '');
	const token = generalSettings.chronicleToken || '';

	if (!token) {
		throw new Error('Geen Chronicle-token ingesteld — open de instellingen van de extensie.');
	}

	const response = await fetch(`${baseUrl}/ingest/chat`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			content: fileContent,
			title: noteName || url,
			url,
			sourceProvider: 'web',
			occurredAt: new Date().toISOString(),
		}),
	});

	const body = await response.json().catch(() => ({} as any));
	if (!response.ok) {
		throw new Error(body.error || `Chronicle gaf status ${response.status}`);
	}

	await incrementStat('addToObsidian');
}
