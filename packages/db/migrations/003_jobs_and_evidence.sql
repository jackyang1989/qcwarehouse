ALTER TABLE outbox_events ADD COLUMN attempts int NOT NULL DEFAULT 0;
ALTER TABLE outbox_events ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE outbox_events ADD COLUMN last_error text;
ALTER TABLE media_assets ADD COLUMN shipment_id uuid REFERENCES shipments;
