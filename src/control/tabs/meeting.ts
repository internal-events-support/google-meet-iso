// Meeting tab. Owned by the meeting task.
import { h } from '../kit';

/** Called once, the first time the tab is shown. `host` is the tab's container. */
export function mountMeeting(host: HTMLElement): void {
  host.append(h('div.empty', 'Meeting — not built yet'));
}
