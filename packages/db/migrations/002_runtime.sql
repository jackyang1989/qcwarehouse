CREATE TABLE pending_registrations (
  token_hash text PRIMARY KEY,
  email citext NOT NULL,
  provider text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  browser_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_user_id uuid REFERENCES users
);
ALTER TABLE verification_challenges ADD COLUMN verified_identity jsonb;
CREATE TABLE shipment_return_items (
  shipment_id uuid NOT NULL REFERENCES shipments,
  item_id uuid NOT NULL REFERENCES warehouse_items,
  received_at timestamptz NOT NULL,
  received_by uuid NOT NULL REFERENCES users,
  location_id uuid NOT NULL REFERENCES storage_locations,
  evidence_ids uuid[] NOT NULL CHECK(cardinality(evidence_ids)>0),
  PRIMARY KEY(shipment_id,item_id)
);
CREATE TABLE private_files (
  key text PRIMARY KEY,
  data bytea NOT NULL,
  mime text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
