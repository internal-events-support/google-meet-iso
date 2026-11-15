// Audio tab. Owned by the audio task.
import { h } from '../kit';

/** Called once, the first time the tab is shown. `host` is the tab's container. */
export function mountAudio(host: HTMLElement): void {
  host.append(h('div.empty', 'Audio — not built yet'));
}
