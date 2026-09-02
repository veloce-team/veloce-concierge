-- Offline analytics lineage v1: switch logical identity from physical deal ID to source/root deal ID.
-- Existing CRM snapshots are rebuildable from Bitrix24. Legacy events/delivery rows are not safely
-- re-keyable without provider-side reconciliation, so populated ledgers fail closed.

CREATE TEMP TABLE lineage_v4_guard (
    pending_delivery_count INTEGER NOT NULL CHECK (pending_delivery_count = 0)
);

INSERT INTO lineage_v4_guard (pending_delivery_count)
SELECT
    (SELECT COUNT(*) FROM analytics_events) +
    (SELECT COUNT(*) FROM yandex_outbox) +
    (SELECT COUNT(*) FROM yandex_order_state);

DROP TABLE lineage_v4_guard;

DELETE FROM crm_deal_state;
