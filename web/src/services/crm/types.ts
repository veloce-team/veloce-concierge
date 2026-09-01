import type { LeadV1 } from '../../schema/lead-v1.js';

export type CrmPayload = {
  name: string;
  email: string;
  phone: string;
  message: string;
  source: 'veloce_site' | 'maxbot_pro';
  channel: string;
  consent?: 'on';
  website?: string;
  landing?: 'home' | 'uk' | 'gos';
  intent?: 'kp' | 'tz';
  product?: 'obrashcheniya' | 'miniapp' | 'zapis' | '';
  lead_event_id?: LeadV1['lead_event_id'];
  context?: LeadV1['context'];
  attribution?: LeadV1['attribution'];
  consent_proof?: LeadV1['consent_proof'];
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
