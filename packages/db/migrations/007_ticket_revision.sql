ALTER TABLE tickets ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE INDEX ticket_events_chronology ON ticket_events(ticket_id, created_at, id);
