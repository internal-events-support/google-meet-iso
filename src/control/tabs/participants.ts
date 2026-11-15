// Participants tab. Owned by the participants task.
import { h } from '../kit';

/** Called once, the first time the tab is shown. `host` is the tab's container. */
export function mountParticipants(host: HTMLElement): void {
  host.append(h('div.empty', 'Participants — not built yet'));
}
