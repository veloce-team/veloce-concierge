import { InlineKeyboard, Keyboard } from 'grammy';
import type {
  InlineKeyboardMarkup,
  ReplyKeyboardMarkup,
} from 'grammy/types';
import type { Button, OutgoingMessage } from '../../core/dialog/types.js';

export type GrammyReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup;

export function isRequestContactLayout(buttons: Button[][]): boolean {
  return buttons.some((row) => row.some((b) => b.kind === 'request_contact'));
}

export function toReplyMarkup(buttons?: Button[][]): GrammyReplyMarkup | undefined {
  if (!buttons || buttons.length === 0) return undefined;

  if (isRequestContactLayout(buttons)) {
    const kb = new Keyboard();
    buttons.forEach((row, idx) => {
      row.forEach((b) => {
        if (b.kind === 'request_contact') kb.requestContact(b.label);
        else kb.text(b.label);
      });
      if (idx < buttons.length - 1) kb.row();
    });
    return kb.resized().oneTime();
  }

  const kb = new InlineKeyboard();
  buttons.forEach((row, idx) => {
    row.forEach((b) => {
      if (b.kind === 'callback') kb.text(b.label, b.data);
      else if (b.kind === 'url') kb.url(b.label, b.url);
    });
    if (idx < buttons.length - 1) kb.row();
  });
  return kb;
}

export type ParsedUpdate = {
  updateId: string;
  chatId?: string;
  text?: string;
  callbackData?: string;
  callbackQueryId?: string;
  contact?: { phone: string; name?: string };
  isCommand: boolean;
  command?: string;
  startParam?: string;
};

export function parseTgUpdate(raw: unknown): ParsedUpdate | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const updateId = u['update_id'];
  if (typeof updateId !== 'number') return null;

  const message = u['message'] as Record<string, unknown> | undefined;
  const callbackQuery = u['callback_query'] as Record<string, unknown> | undefined;

  if (message) {
    const chat = message['chat'] as Record<string, unknown> | undefined;
    const chatId = chat?.['id'];
    const text = typeof message['text'] === 'string' ? (message['text'] as string) : undefined;
    const entities = (message['entities'] as Array<Record<string, unknown>> | undefined) ?? [];
    const cmdEntity = entities.find((e) => e['type'] === 'bot_command' && e['offset'] === 0);
    const isCommand = Boolean(cmdEntity);
    let command: string | undefined;
    let startParam: string | undefined;
    if (isCommand && text) {
      const len = (cmdEntity?.['length'] as number) ?? 0;
      command = text.slice(1, len).split('@')[0];
      if (command === 'start') {
        const tail = text.slice(len).trim();
        if (tail) startParam = tail.split(/\s+/)[0];
      }
    }

    const contactRaw = message['contact'] as Record<string, unknown> | undefined;
    const contact = contactRaw
      ? {
          phone: String(contactRaw['phone_number'] ?? ''),
          name: contactRaw['first_name'] ? String(contactRaw['first_name']) : undefined,
        }
      : undefined;

    return {
      updateId: String(updateId),
      chatId: chatId !== undefined ? String(chatId) : undefined,
      text,
      isCommand,
      command,
      startParam,
      contact,
    };
  }

  if (callbackQuery) {
    const message = callbackQuery['message'] as Record<string, unknown> | undefined;
    const chat = message?.['chat'] as Record<string, unknown> | undefined;
    const chatId = chat?.['id'];
    const data = callbackQuery['data'];
    return {
      updateId: String(updateId),
      chatId: chatId !== undefined ? String(chatId) : undefined,
      callbackData: typeof data === 'string' ? data : undefined,
      callbackQueryId: String(callbackQuery['id'] ?? ''),
      isCommand: false,
    };
  }

  return {
    updateId: String(updateId),
    isCommand: false,
  };
}
