import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { ColorPalette } from '#/tui/theme/colors';

const PLATFORM_OPTIONS: readonly ChoiceOption[] = [
  { value: 'kimi-code', label: 'Kimi Code' },
  { value: 'moonshot-cn', label: 'Moonshot AI Open Platform (moonshot.cn)' },
  { value: 'moonshot-ai', label: 'Moonshot AI Open Platform (moonshot.ai)' },
];

export interface PlatformSelectorOptions {
  readonly colors: ColorPalette;
  readonly onSelect: (platformId: string) => void;
  readonly onCancel: () => void;
}

export class PlatformSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PlatformSelectorOptions) {
    super({
      title: 'Select a platform',
      options: [...PLATFORM_OPTIONS],
      colors: opts.colors,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
