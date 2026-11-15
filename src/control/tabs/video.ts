// Video tab. Owned by the video task.
import { h } from '../kit';

/** Called once, the first time the tab is shown. `host` is the tab's container. */
export function mountVideo(host: HTMLElement): void {
  host.append(h('div.empty', 'Video — not built yet'));
}
