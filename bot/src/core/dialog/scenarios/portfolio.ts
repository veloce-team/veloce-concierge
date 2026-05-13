import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PORTFOLIO_TEXT,
  PORTFOLIO_URL_PLACEHOLDER,
} from '../menu.js';
import type { Button, ScenarioStepResult } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
// scenarios → core/dialog → src → assets/portfolio
const ASSETS_DIR = join(here, '..', '..', '..', 'assets', 'portfolio');

const PORTFOLIO_BUTTONS: Button[][] = [
  [{ kind: 'url', label: 'Открыть на сайте', url: PORTFOLIO_URL_PLACEHOLDER }],
  [{ kind: 'callback', label: '← Назад в меню', data: 'main:menu' }],
];

export function enterPortfolio(): ScenarioStepResult {
  return {
    next: { scenario: 'idle', data: {} },
    outgoing: [
      {
        text: PORTFOLIO_TEXT,
        photos: [join(ASSETS_DIR, 'phon-1.jpg'), join(ASSETS_DIR, 'phon-2.jpg')],
        buttons: PORTFOLIO_BUTTONS,
      },
    ],
  };
}
