import { GREETING, MAIN_MENU_BUTTONS } from '../menu.js';
import type { ScenarioStepResult } from '../types.js';

export function startScenario(): ScenarioStepResult {
  return {
    next: { scenario: 'idle', data: {} },
    outgoing: [
      {
        text: GREETING,
        buttons: MAIN_MENU_BUTTONS,
      },
    ],
  };
}
