export const ANALYTICS_CONTRACT_VERSION = 1;
export const WORKING_CATEGORY_IDS = new Set(['2', '4', '6']);
export const EXCLUDED_CATEGORY_IDS = new Set(['10', '12']);

export type AnalyticsDeal = {
  portalId: string;
  dealId: string;
  sourceDealId: string;
  contactId: string | null;
  categoryId: string;
  stageId: string;
  createdAt: string;
  modifiedAt: string;
  opportunity: string | null;
  currencyId: string | null;
  ymClientId: string | null;
};

export type AnalyticsHistoryItem = {
  id: string;
  categoryId: string;
  stageId: string;
  createdAt: string;
};

export type AnalyticsState = {
  portalId: string;
  dealId: string;
  qualifiedAt: string | null;
  signedAt: string | null;
  signedRevenue: string | null;
  signedCurrency: string | null;
  wonAt: string | null;
  cancelledAt: string | null;
  lastPayloadHash: string | null;
  payloadRevision: number;
};

export type AnalyticsEventType = 'qualified_lead' | 'won_deal';

export type AnalyticsEvent = {
  type: AnalyticsEventType;
  occurredAt: string;
  contractVersion: number;
};

export type YandexOrder = {
  id: string;
  createDateTime: string;
  clientUniqId: string;
  clientIds: string;
  status: 'qualified_lead' | 'won_deal' | 'CANCELLED';
  revenue: string;
  currency: string;
};

export type AnalyticsTransition = {
  nextState: AnalyticsState;
  events: AnalyticsEvent[];
  order: YandexOrder | null;
  suppressDelivery: boolean;
  holdDelivery?: boolean;
  alerts: string[];
};

function ordered(history: AnalyticsHistoryItem[]): AnalyticsHistoryItem[] {
  return [...history].sort((a, b) => {
    const byDate = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    return byDate === 0 ? a.id.localeCompare(b.id, undefined, { numeric: true }) : byDate;
  });
}

function firstQualifiedAt(history: AnalyticsHistoryItem[]): string | null {
  const rows = ordered(history);
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    if (previous.categoryId === '0' && WORKING_CATEGORY_IDS.has(current.categoryId)) {
      return current.createdAt;
    }
  }
  return null;
}

function firstStageAt(history: AnalyticsHistoryItem[], stageIds: Set<string>): string | null {
  return ordered(history).find((item) => stageIds.has(item.stageId))?.createdAt ?? null;
}

function signedStages(): Set<string> {
  return new Set([...WORKING_CATEGORY_IDS].map((categoryId) => `C${categoryId}:FINAL_INVOICE`));
}

function wonStages(): Set<string> {
  return new Set([...WORKING_CATEGORY_IDS].map((categoryId) => `C${categoryId}:WON`));
}

function isCancelledStage(stageId: string): boolean {
  return /(^|:)(LOSE|LOSE\d+|APOLOGY|SPAM|CANCELLED)$/.test(stageId);
}

function validRevenue(value: string | null, currency: string | null): value is string {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value) || !currency || !/^[A-Z]{3}$/.test(currency)) {
    return false;
  }
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0;
}

export function deriveAnalyticsTransition(
  deal: AnalyticsDeal,
  history: AnalyticsHistoryItem[],
  previous: AnalyticsState,
  qualificationHistory: AnalyticsHistoryItem[] = history,
  statusHistoryIsAuthoritative = false,
): AnalyticsTransition {
  const alerts: string[] = [];
  const events: AnalyticsEvent[] = [];
  const suppressedState = statusHistoryIsAuthoritative
    ? {
        ...previous,
        portalId: deal.portalId,
        dealId: deal.dealId,
        signedAt: null,
        signedRevenue: null,
        signedCurrency: null,
        wonAt: null,
        cancelledAt: null,
      }
    : { ...previous, portalId: deal.portalId, dealId: deal.dealId };
  if (EXCLUDED_CATEGORY_IDS.has(deal.categoryId)) {
    return {
      nextState: suppressedState,
      events,
      order: null,
      suppressDelivery: true,
      alerts,
    };
  }
  if (deal.categoryId !== '0' && !WORKING_CATEGORY_IDS.has(deal.categoryId)) {
    alerts.push(`unknown_category:${deal.categoryId}`);
    return {
      nextState: suppressedState,
      events,
      order: null,
      suppressDelivery: true,
      alerts,
    };
  }
  const qualifiedAt = previous.qualifiedAt ?? firstQualifiedAt(qualificationHistory);
  const signedAt = statusHistoryIsAuthoritative
    ? firstStageAt(history, signedStages())
    : previous.signedAt ?? firstStageAt(history, signedStages());
  const wonAt = statusHistoryIsAuthoritative
    ? firstStageAt(history, wonStages())
    : previous.wonAt ?? firstStageAt(history, wonStages());
  const historyCancelledAt =
    ordered(history).find((item) => isCancelledStage(item.stageId))?.createdAt ?? null;
  const cancelledAt = statusHistoryIsAuthoritative
    ? historyCancelledAt
    : previous.cancelledAt ?? historyCancelledAt;

  if (!previous.qualifiedAt && qualifiedAt) {
    events.push({
      type: 'qualified_lead',
      occurredAt: qualifiedAt,
      contractVersion: ANALYTICS_CONTRACT_VERSION,
    });
  }
  if (!previous.wonAt && wonAt) {
    events.push({
      type: 'won_deal',
      occurredAt: wonAt,
      contractVersion: ANALYTICS_CONTRACT_VERSION,
    });
  }

  const nextState: AnalyticsState = {
    ...previous,
    portalId: deal.portalId,
    dealId: deal.dealId,
    qualifiedAt,
    signedAt,
    signedRevenue: statusHistoryIsAuthoritative ? null : previous.signedRevenue,
    signedCurrency: statusHistoryIsAuthoritative ? null : previous.signedCurrency,
    wonAt,
    cancelledAt,
  };

  if (!deal.ymClientId) {
    if (nextState.qualifiedAt) alerts.push('missing_ym_client_id');
    return { nextState, events, order: null, suppressDelivery: false, alerts };
  }

  if (!qualifiedAt) {
    return { nextState, events: [], order: null, suppressDelivery: false, alerts };
  }

  if (signedAt) {
    if (validRevenue(deal.opportunity, deal.currencyId)) {
      // Revenue is intentionally mutable business state. Bitrix24's current
      // OPPORTUNITY/CURRENCY_ID is authoritative after signing has begun.
      nextState.signedRevenue = deal.opportunity;
      nextState.signedCurrency = deal.currencyId;
    } else if (!isCancelledStage(deal.stageId)) {
      alerts.push('invalid_current_contract_value');
      return {
        nextState,
        events,
        order: null,
        suppressDelivery: false,
        holdDelivery: true,
        alerts,
      };
    }
  } else if (wonAt && !isCancelledStage(deal.stageId)) {
    alerts.push('won_without_signing_stage');
    return { nextState, events, order: null, suppressDelivery: false, alerts };
  }

  let status: YandexOrder['status'] = 'qualified_lead';
  let revenue = signedAt ? deal.opportunity! : '0';
  if (cancelledAt && isCancelledStage(deal.stageId)) {
    status = 'CANCELLED';
    revenue = '0';
  } else if (wonAt && wonStages().has(deal.stageId)) {
    status = 'won_deal';
  }

  const order: YandexOrder = {
    id: `b24:${deal.portalId}:deal:${deal.dealId}`,
    createDateTime: qualifiedAt,
    clientUniqId: deal.contactId
      ? `b24:${deal.portalId}:contact:${deal.contactId}`
      : `b24:${deal.portalId}:deal:${deal.dealId}`,
    clientIds: deal.ymClientId,
    status,
    revenue,
    currency:
      nextState.signedCurrency ??
      (deal.currencyId && /^[A-Z]{3}$/.test(deal.currencyId) ? deal.currencyId : 'RUB'),
  };

  return { nextState, events, order, suppressDelivery: false, alerts };
}
