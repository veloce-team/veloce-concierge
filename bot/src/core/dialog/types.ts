export type Platform = 'tg' | 'max';

export type Button =
  | { kind: 'callback'; label: string; data: string }
  | { kind: 'url'; label: string; url: string }
  | { kind: 'request_contact'; label: string };

export type OutgoingMessage = {
  text: string;
  buttons?: Button[][];
  photos?: string[];
};

export type IncomingMessage = {
  platform: Platform;
  chatId: string;
  updateId: string;
  text?: string;
  callbackData?: string;
  contact?: { phone: string; name?: string };
  isCommand: boolean;
  command?: string;
};

export type ScenarioId = 'idle' | 'contact' | 'portfolio' | 'estimate';
export type ContactStep =
  | 'awaiting_name'
  | 'awaiting_phone'
  | 'awaiting_description'
  | 'done';
export type EstimateStep = 'menu' | 'answer';

export type DialogData = {
  name?: string;
  phone?: string;
  description?: string;
  estimateChoice?: string;
};

export type DialogContext = {
  scenario: ScenarioId;
  step?: ContactStep | EstimateStep;
  data: DialogData;
};

export type CrmPayload = {
  name: string;
  phone: string;
  description: string;
  chatId: string;
  contactId?: number;
  dealId?: number;
};

export type SideEffect = { kind: 'enqueue_crm'; payload: CrmPayload };

export type ScenarioStepResult = {
  next: DialogContext;
  outgoing: OutgoingMessage[];
  sideEffects?: SideEffect[];
};

export interface BotAdapter {
  send(chatId: string, msg: OutgoingMessage): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
}

export interface CRMClient {
  createLead(payload: CrmPayload): Promise<{ contactId: number; dealId: number }>;
}

export interface SessionStore {
  load(platform: Platform, chatId: string): DialogContext | null;
  save(platform: Platform, chatId: string, ctx: DialogContext): void;
  markProcessed(platform: Platform, updateId: string): boolean;
  countActive(): number;
}

export const INITIAL_CONTEXT: DialogContext = {
  scenario: 'idle',
  data: {},
};
