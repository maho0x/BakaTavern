import type { IconName } from '../../components/Icon.svelte';
import type { MessageKey } from '../../i18n/index.svelte.ts';
import type { PanelId } from '../../state/ui.svelte.ts';

/** Side panels, in dock order. */
export const panelTabs: { id: PanelId; icon: IconName; label: MessageKey }[] = [
  { id: 'connection', icon: 'plug', label: 'panel.connection' },
  { id: 'preset', icon: 'sliders', label: 'panel.preset' },
  { id: 'formatting', icon: 'text', label: 'panel.formatting' },
  { id: 'persona', icon: 'user', label: 'panel.persona' },
  { id: 'worldinfo', icon: 'book', label: 'panel.worldinfo' },
  { id: 'regex', icon: 'regex', label: 'panel.regex' },
  { id: 'settings', icon: 'gear', label: 'panel.settings' },
];
