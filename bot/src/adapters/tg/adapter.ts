import { Bot, InputFile, InputMediaBuilder } from 'grammy';
import type { BotAdapter, OutgoingMessage } from '../../core/dialog/types.js';
import { toReplyMarkup } from './mappers.js';

export function createTgAdapter(token: string): BotAdapter & { bot: Bot } {
  const bot = new Bot(token);

  return {
    bot,
    async setWebhook(url, secret) {
      await bot.api.setWebhook(url, {
        secret_token: secret,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      });
    },
    async send(chatId, msg: OutgoingMessage) {
      const replyMarkup = toReplyMarkup(msg.buttons);

      if (msg.photos && msg.photos.length > 0) {
        if (msg.photos.length === 1) {
          await bot.api.sendPhoto(chatId, new InputFile(msg.photos[0]!), {
            caption: msg.text,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          });
          return;
        }

        const media = msg.photos.map((p) =>
          InputMediaBuilder.photo(new InputFile(p)),
        );
        await bot.api.sendMediaGroup(chatId, media);
        await bot.api.sendMessage(chatId, msg.text, {
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        return;
      }

      await bot.api.sendMessage(chatId, msg.text, {
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    },
  };
}
