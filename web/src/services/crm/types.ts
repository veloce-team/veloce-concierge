import type { Lead } from '../../schema/lead.js';

export type CrmPayload = Lead & {
  sourceId: string;
  contactId?: number;
  dealId?: number;
};

export type CrmResult = {
  contactId: number;
  dealId: number;
};

export interface CRMClient {
  createWebLead(payload: CrmPayload): Promise<CrmResult>;
}
