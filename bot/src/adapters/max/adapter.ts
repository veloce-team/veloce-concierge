import type { BotAdapter } from '../../core/dialog/types.js';

const NOT_IMPLEMENTED = 'MAX adapter not implemented yet, see Block 2б';

export function createMaxAdapter(): BotAdapter {
  return {
    async send() {
      throw new Error(NOT_IMPLEMENTED);
    },
    async setWebhook() {
      throw new Error(NOT_IMPLEMENTED);
    },
  };
}
