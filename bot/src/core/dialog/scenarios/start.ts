import { resolveSourceId } from '../../../config/sources.js';
import { GREETING, MAIN_MENU_BUTTONS } from '../menu.js';
import type { ScenarioStepResult } from '../types.js';

export function startScenario(startParam?: string): ScenarioStepResult {
  const { sourceId } = resolveSourceId(startParam);
  return {
    next: { scenario: 'idle', data: {}, sourceId },
    outgoing: [
      {
        text: GREETING,
        buttons: MAIN_MENU_BUTTONS,
      },
    ],
  };
}
