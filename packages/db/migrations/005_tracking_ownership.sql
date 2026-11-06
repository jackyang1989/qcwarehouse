-- Normalize nullable ownership for the package FK so an unclaimed record cannot
-- reference a claimed package (or vice versa) via MATCH SIMPLE's NULL handling.
ALTER TABLE packages ADD COLUMN tracking_owner_key text
  GENERATED ALWAYS AS (coalesce(org_id::text,'')) STORED;
ALTER TABLE packages ADD UNIQUE (id,tracking_owner_key), ADD UNIQUE (id,advice_id);

ALTER TABLE tracking_records ADD COLUMN tracking_owner_key text
  GENERATED ALWAYS AS (coalesce(org_id::text,'')) STORED,
  ADD COLUMN batch_id uuid;

UPDATE tracking_records AS tracking SET batch_id=shipment.batch_id
FROM shipments AS shipment WHERE shipment.id=tracking.shipment_id;

ALTER TABLE tracking_records
  ADD CHECK (generation>0),
  ADD CHECK (advice_id IS NULL OR org_id IS NOT NULL),
  ADD CHECK (
    (shipment_id IS NULL AND batch_id IS NULL) OR
    (shipment_id IS NOT NULL AND batch_id IS NOT NULL AND org_id IS NOT NULL
      AND advice_id IS NULL AND package_id IS NULL)
  ),
  ADD FOREIGN KEY (advice_id,org_id) REFERENCES package_advices(id,org_id),
  ADD FOREIGN KEY (package_id,tracking_owner_key) REFERENCES packages(id,tracking_owner_key)
    DEFERRABLE INITIALLY DEFERRED,
  ADD FOREIGN KEY (package_id,advice_id) REFERENCES packages(id,advice_id),
  ADD FOREIGN KEY (shipment_id,batch_id) REFERENCES shipments(id,batch_id),
  ADD FOREIGN KEY (batch_id,org_id) REFERENCES dispatch_batches(id,org_id);

CREATE UNIQUE INDEX tracking_one_active_advice ON tracking_records(advice_id)
  WHERE closed_at IS NULL AND advice_id IS NOT NULL;
CREATE UNIQUE INDEX tracking_one_active_package ON tracking_records(package_id)
  WHERE closed_at IS NULL AND package_id IS NOT NULL;
CREATE UNIQUE INDEX tracking_one_active_shipment_direction ON tracking_records(shipment_id,direction)
  WHERE closed_at IS NULL AND shipment_id IS NOT NULL;
