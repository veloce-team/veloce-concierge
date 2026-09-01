-- Durable Analytics Contract v1 identity and confirmed CRM result.
ALTER TABLE outbox ADD COLUMN lead_event_id TEXT;
ALTER TABLE outbox ADD COLUMN crm_entity_type TEXT;
ALTER TABLE outbox ADD COLUMN crm_entity_id TEXT;

CREATE UNIQUE INDEX idx_outbox_lead_event_id
    ON outbox(lead_event_id)
    WHERE lead_event_id IS NOT NULL;
