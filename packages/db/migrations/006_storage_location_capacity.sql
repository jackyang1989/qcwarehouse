ALTER TABLE storage_locations
  ADD COLUMN capacity integer CHECK (capacity BETWEEN 1 AND 999),
  ADD COLUMN notes text CHECK (length(notes) <= 200);

CREATE INDEX warehouse_items_occupied_location ON warehouse_items(location_id)
  WHERE custody_state IN ('received','stored');
