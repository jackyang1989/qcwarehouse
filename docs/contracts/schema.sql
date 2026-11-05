-- QC Warehouse R1. PostgreSQL 16, empty database. No operational seed data.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  
  auth_version integer NOT NULL DEFAULT 1,
  display_name text,
  locale text NOT NULL DEFAULT 'en',
  timezone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','restricted','disabled','closed')),
  password_hash text,            -- 仅员工账号
  mfa_secret_enc text,           -- 仅员工账号，加密存储
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal','business')),
  country text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','member')),
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE warehouse_addresses (
  id uuid PRIMARY KEY, address_zh text NOT NULL, address_en text NOT NULL,
  contact_name text NOT NULL, contact_phone text NOT NULL, active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false CHECK (NOT is_default OR active),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX one_default_address ON warehouse_addresses(is_default) WHERE is_default;

CREATE TABLE customer_receiving_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id), receiving_code text NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id), created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_roles (
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('receiver','inspector','reviewer','warehouse_admin','support','super_admin','template_admin','finance')),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('customer','staff')),
  token_hash text NOT NULL UNIQUE,
  auth_version int NOT NULL, mfa_at timestamptz, reauth_at timestamptz,
  ip inet, user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE terms_versions (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('terms','privacy','restricted_items','report_notice')),
  version text NOT NULL,
  effective_at timestamptz,
  content_md text NOT NULL,
  content_hash text NOT NULL,
  UNIQUE (kind, version)
);

CREATE TABLE user_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  original_email text NOT NULL,
  normalized_email citext NOT NULL,
  verified_at timestamptz,
  is_primary boolean NOT NULL DEFAULT false,
  login_enabled boolean NOT NULL DEFAULT false,
  delivery_state text,
  CHECK (NOT login_enabled OR verified_at IS NOT NULL)
);

CREATE UNIQUE INDEX login_email ON user_emails(normalized_email) WHERE login_enabled;
CREATE UNIQUE INDEX primary_email ON user_emails(user_id) WHERE is_primary;

CREATE TABLE auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  provider text NOT NULL CHECK(provider IN ('google','microsoft','email_otp')),
  issuer text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL,
  linked_at timestamptz NOT NULL,
  last_authenticated_at timestamptz,
  UNIQUE(provider,issuer,subject)
);

CREATE TABLE auth_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_digest text UNIQUE NOT NULL,
  provider text NOT NULL,
  intent text NOT NULL,
  initiator_user_id uuid REFERENCES users(id),
  browser_binding_hash text NOT NULL,
  nonce_digest text NOT NULL,
  verifier_ciphertext bytea NOT NULL,
  return_path text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE verification_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_email citext NOT NULL,
  purpose text NOT NULL,
  initiator_user_id uuid REFERENCES users(id),
  browser_binding_hash text NOT NULL,
  code_hmac text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  generation int NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE account_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  terms_version_id uuid NOT NULL REFERENCES terms_versions,
  accepted_at timestamptz NOT NULL,
  source text NOT NULL,
  UNIQUE(user_id,terms_version_id)
);

CREATE TABLE account_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  actor_id uuid REFERENCES users(id),
  identity_id uuid REFERENCES auth_identities,
  kind text NOT NULL,
  outcome text NOT NULL,
  request_id uuid NOT NULL,
  occurred_at timestamptz DEFAULT now()
);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  parent_id uuid REFERENCES categories,
  labels jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('PLANNED','ACTIVE','PAUSED','RESTRICTED','RETIRED')),
  admission_snapshot jsonb,
  revision int NOT NULL DEFAULT 1
);

CREATE TABLE capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  method text NOT NULL,
  approval jsonb NOT NULL,
  approved_by uuid REFERENCES users(id),
  revoked_at timestamptz
);

CREATE TABLE service_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  labels jsonb NOT NULL
);

CREATE TABLE template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text NOT NULL,
  category_id uuid NOT NULL REFERENCES categories,
  service_type_id uuid NOT NULL REFERENCES service_types,
  version int NOT NULL,
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('DRAFT','IN_REVIEW','APPROVED','PUBLISHED','DEPRECATED','RETIRED')),
  author_id uuid NOT NULL REFERENCES users,
  reviewer_id uuid REFERENCES users(id),
  published_at timestamptz,
  UNIQUE(template_key,version),
  UNIQUE(id,category_id,service_type_id),
  CHECK(state NOT IN ('APPROVED','PUBLISHED','DEPRECATED','RETIRED') OR (reviewer_id IS NOT NULL AND reviewer_id<>author_id))
);

CREATE TABLE template_capabilities(template_version_id uuid REFERENCES template_versions, capability_id uuid REFERENCES capabilities, PRIMARY KEY(template_version_id,capability_id));

CREATE TABLE service_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_code text NOT NULL UNIQUE,
  service_type_id uuid NOT NULL REFERENCES service_types,
  title jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  UNIQUE(id,service_type_id)
);

CREATE TABLE offer_templates(offer_id uuid NOT NULL, category_id uuid NOT NULL, service_type_id uuid NOT NULL, template_version_id uuid NOT NULL, FOREIGN KEY(offer_id,service_type_id) REFERENCES service_offers(id,service_type_id), FOREIGN KEY(template_version_id,category_id,service_type_id) REFERENCES template_versions(id,category_id,service_type_id), PRIMARY KEY(offer_id,category_id,template_version_id));

CREATE TABLE sku_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES service_offers,
  version int NOT NULL,
  currency text NOT NULL CHECK(currency='USD'),
  rules jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  UNIQUE(offer_id,version)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  public_no text NOT NULL UNIQUE,                    -- QW-XXXXXXXX
  org_id uuid NOT NULL REFERENCES organizations(id),
  created_by uuid NOT NULL REFERENCES users(id),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','awaiting_payment','awaiting_samples','samples_ready','queued','inspecting','qa_review','report_ready','action_pending','closed','on_hold','cancelled')),
  revision int NOT NULL DEFAULT 1, held_at timestamptz, held_from_state text, submission_snapshot jsonb, hold_reason text,
  price_cents int,
  currency text DEFAULT 'USD',
  price_snapshot jsonb,                              -- sku_price_id、折扣、明细
  customer_notes text CHECK (char_length(customer_notes) <= 500),
  is_test boolean NOT NULL DEFAULT false,
  source jsonb,                                      -- utm、referral_code
  paid_at timestamptz,
  samples_ready_at timestamptz,
  sla_due_at timestamptz,
  report_published_at timestamptz,
  closed_at timestamptz,
  UNIQUE(id, org_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  org_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  category_id uuid NOT NULL,
  template_version_id uuid NOT NULL,
  quantity int NOT NULL CHECK(quantity>0),
  options jsonb NOT NULL,
  attributes jsonb NOT NULL,
  FOREIGN KEY(order_id,org_id) REFERENCES orders(id,org_id),
  FOREIGN KEY(offer_id,category_id,template_version_id) REFERENCES offer_templates,
  UNIQUE(id,org_id),
  UNIQUE(id,template_version_id)
);

CREATE TABLE inspection_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders,
  revision int NOT NULL,
  line_snapshot jsonb NOT NULL,
  terms_snapshot jsonb NOT NULL,
  amount_cents int NOT NULL CHECK(amount_cents>=0),
  currency text NOT NULL CHECK(currency='USD'),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  UNIQUE(order_id,revision)
);

CREATE TABLE expected_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id uuid NOT NULL REFERENCES order_lines,
  position int NOT NULL CHECK(position>0),
  declared_fields jsonb NOT NULL,
  in_scope boolean NOT NULL DEFAULT true,
  UNIQUE(order_line_id,position),
  UNIQUE(id,order_line_id)
);

CREATE TABLE storage_locations (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,                         -- 如 Q-01-2-03
  zone text NOT NULL CHECK (zone IN ('receiving','queue','inspecting','post_inspection','reference','unmatched','quarantine')),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE package_advices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES customer_receiving_profiles,
  org_id uuid NOT NULL REFERENCES organizations,
  address_id uuid NOT NULL REFERENCES warehouse_addresses,
  address_snapshot jsonb NOT NULL,
  revision int NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  UNIQUE(id,org_id)
);

CREATE TABLE advice_orders(advice_id uuid,order_id uuid,org_id uuid NOT NULL,FOREIGN KEY(advice_id,org_id) REFERENCES package_advices(id,org_id),FOREIGN KEY(order_id,org_id) REFERENCES orders(id,org_id),PRIMARY KEY(advice_id,order_id));

CREATE TABLE packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  org_id uuid REFERENCES organizations,
  advice_id uuid UNIQUE REFERENCES package_advices,
  received_by uuid NOT NULL REFERENCES users,
  received_at timestamptz NOT NULL,
  received_quantity int CHECK(received_quantity>=0),
  weight_g int CHECK(weight_g>0),
  condition_note text,
  state text NOT NULL,
  location_id uuid REFERENCES storage_locations,
  revision int NOT NULL DEFAULT 1
);

CREATE TABLE warehouse_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  org_id uuid REFERENCES organizations,
  package_id uuid NOT NULL REFERENCES packages,
  parent_item_id uuid REFERENCES warehouse_items,
  intake_batch_id uuid NOT NULL,
  identity_state text NOT NULL,
  condition_state text NOT NULL,
  custody_state text NOT NULL,
  location_id uuid REFERENCES storage_locations,
  received_at timestamptz NOT NULL,
  storage_until timestamptz,
  revision int NOT NULL DEFAULT 1,
  UNIQUE(id,org_id)
);

CREATE TABLE order_line_item_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  expected_item_id uuid NOT NULL,
  item_id uuid NOT NULL,
  linked_at timestamptz NOT NULL,
  unlinked_at timestamptz,
  reason text,
  FOREIGN KEY(expected_item_id,order_line_id) REFERENCES expected_items(id,order_line_id),
  FOREIGN KEY(order_line_id,org_id) REFERENCES order_lines(id,org_id),
  FOREIGN KEY(item_id,org_id) REFERENCES warehouse_items(id,org_id),
  UNIQUE(id,order_line_id)
);

CREATE UNIQUE INDEX active_assignment ON order_line_item_links(item_id) WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX active_position ON order_line_item_links(expected_item_id) WHERE unlinked_at IS NULL;

CREATE VIEW samples AS SELECT w.id,w.code,l.order_line_id,l.expected_item_id,w.org_id,w.custody_state,w.location_id FROM warehouse_items w JOIN order_line_item_links l ON l.item_id=w.id AND l.unlinked_at IS NULL;

CREATE TABLE storage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid REFERENCES warehouse_items,
  package_id uuid REFERENCES packages,
  from_location_id uuid REFERENCES storage_locations,
  to_location_id uuid REFERENCES storage_locations,
  action text NOT NULL,
  operator_id uuid NOT NULL REFERENCES users,
  created_at timestamptz DEFAULT now(),
  CHECK(num_nonnulls(item_id,package_id)=1)
);

CREATE TABLE reference_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES warehouse_items,
  org_id uuid NOT NULL REFERENCES organizations,
  revision int NOT NULL,
  authorization_snapshot jsonb NOT NULL,
  condition_note text,
  expires_at timestamptz NOT NULL,
  state text NOT NULL,
  UNIQUE(item_id,revision),
  FOREIGN KEY(item_id,org_id) REFERENCES warehouse_items(id,org_id)
);

CREATE TABLE inspection_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id uuid NOT NULL REFERENCES order_lines,
  purpose text NOT NULL CHECK(purpose IN ('compare','reference_match')),
  reference_id uuid REFERENCES reference_samples,
  CHECK((purpose='reference_match')=(reference_id IS NOT NULL)),
  UNIQUE(id,order_line_id)
);

CREATE TABLE group_members(group_id uuid,assignment_id uuid,order_line_id uuid NOT NULL,FOREIGN KEY(group_id,order_line_id) REFERENCES inspection_groups(id,order_line_id),FOREIGN KEY(assignment_id,order_line_id) REFERENCES order_line_item_links(id,order_line_id),PRIMARY KEY(group_id,assignment_id));

CREATE TABLE inspection_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id uuid NOT NULL,
  template_version_id uuid NOT NULL,
  assignment_id uuid,
  group_id uuid,
  assignee_id uuid REFERENCES users(id),
  state text NOT NULL CHECK(state IN ('PENDING','READY','ASSIGNED','IN_PROGRESS','SUBMITTED','QA_APPROVED','VOID')),
  revision int NOT NULL DEFAULT 1,
  CHECK(num_nonnulls(assignment_id,group_id)=1),
  FOREIGN KEY(order_line_id,template_version_id) REFERENCES order_lines(id,template_version_id),
  FOREIGN KEY(assignment_id,order_line_id) REFERENCES order_line_item_links(id,order_line_id),
  FOREIGN KEY(group_id,order_line_id) REFERENCES inspection_groups(id,order_line_id)
);

CREATE TABLE inspection_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES inspection_tasks,
  item_key text NOT NULL,
  component text NOT NULL DEFAULT 'main',
  attempt int NOT NULL CHECK(attempt>0),
  status text NOT NULL CHECK(status IN ('RECORDED','OBSERVED_ISSUE','NOT_OBSERVED','NOT_TESTED','NOT_APPLICABLE','BLOCKED')),
  typed_value jsonb,
  unit text,
  method text NOT NULL,
  reason text,
  details jsonb,
  is_final boolean NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users,
  recorded_at timestamptz DEFAULT now(),
  UNIQUE(task_id,item_key,component,attempt),
  CHECK(status NOT IN ('NOT_TESTED','NOT_APPLICABLE','BLOCKED') OR (typed_value IS NULL AND nullif(trim(reason),'') IS NOT NULL))
);

CREATE UNIQUE INDEX one_final_result ON inspection_results(task_id,item_key,component) WHERE is_final;

CREATE TABLE media_assets (
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES organizations(id),
  order_id uuid REFERENCES orders(id),
  item_id uuid REFERENCES warehouse_items,
  package_id uuid REFERENCES packages(id),
  task_id uuid REFERENCES inspection_tasks,
  kind text NOT NULL CHECK (kind IN ('intake_outer','intake_open','shot','defect','attachment','label_photo','dispatch')),
  component text,
  shot_code text,                                    -- front、back、tag ...
  point_code text,                                   -- 测量证据照
  result_id uuid REFERENCES inspection_results,
  object_key text NOT NULL UNIQUE,
  thumb_key text,
  mime text NOT NULL,
  size_bytes int NOT NULL,
  width int, height int,
  sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','rejected')),
  captured_at timestamptz,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE step_timings (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  step_code text NOT NULL CHECK (step_code IN ('intake','unbox_label','prep','measure','visual','compare','qa_review','pack_dispatch','support')),
  operator_id uuid NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  seconds int GENERATED ALWAYS AS (CASE WHEN ended_at IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM (ended_at - started_at))::int END) STORED
);

CREATE TABLE order_costs (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  payment_fee_cents int NOT NULL DEFAULT 0,
  labor_cents int NOT NULL DEFAULT 0,
  materials_cents int NOT NULL DEFAULT 0,
  domestic_shipping_cents int NOT NULL DEFAULT 0,
  acquisition_cents int NOT NULL DEFAULT 0,
  support_minutes int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  public_no text NOT NULL UNIQUE,                    -- RP-XXXXXXXX
  current_version int NOT NULL DEFAULT 1,
  published_version int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE report_versions (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES reports(id),
  version int NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','submitted','qa_approved','published','superseded')),
  snapshot jsonb NOT NULL,                           -- 完整装配结果，发布后不可改
  created_by uuid NOT NULL REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  published_at timestamptz,
  amend_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, version)
);

CREATE TABLE report_shares (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES reports(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consents (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  user_id uuid NOT NULL REFERENCES users(id),
  terms_version_ids uuid[] NOT NULL,
  acknowledgements jsonb NOT NULL,                   -- {scope_notice:true, seller_refund_notice:true, ...}
  ip inet, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id bigserial PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('customer','staff','system')),
  actor_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  before jsonb, after jsonb,
  ip inet, meta jsonb
);

CREATE TABLE tickets (
  id uuid PRIMARY KEY,
  public_no text NOT NULL UNIQUE,
  org_id uuid REFERENCES organizations(id),
  order_id uuid REFERENCES orders(id),
  category text NOT NULL CHECK (category IN ('identity_unclear','receipt_mismatch','measurement_dispute','return_info_incomplete','damage_or_loss','payment_refund','privacy_share','non_standard_quote')),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','waiting_customer','waiting_internal','resolved','closed')),
  subject text NOT NULL,
  assignee_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE ticket_events (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  actor_type text NOT NULL CHECK (actor_type IN ('customer','staff','system')),
  actor_id uuid,
  kind text NOT NULL CHECK (kind IN ('message','internal_note','state_change','evidence')),
  body text,
  media_ids uuid[],
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE report_versions ADD COLUMN pdf_key text UNIQUE, ADD COLUMN pdf_sha256 text, ADD COLUMN renderer_version text;

ALTER TABLE tickets ADD COLUMN details jsonb NOT NULL DEFAULT jsonb_build_object();

CREATE TABLE disposition_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  item_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('to_forwarder','to_domestic_address','return_to_seller','retain','reserve_reference')),
  destination jsonb,
  return_info jsonb,
  authorization_snapshot jsonb NOT NULL,
  state text NOT NULL,
  revision int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users,
  FOREIGN KEY(item_id,org_id) REFERENCES warehouse_items(id,org_id),
  UNIQUE(id,item_id,org_id)
);

CREATE UNIQUE INDEX active_instruction ON disposition_requests(item_id) WHERE state NOT IN ('completed','cancelled');

CREATE TABLE dispatch_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations,
  destination_snapshot jsonb NOT NULL,
  action text NOT NULL,
  revision int NOT NULL,
  state text NOT NULL,
  UNIQUE(id,org_id)
);

CREATE TABLE dispatch_batch_items(batch_id uuid,item_id uuid,disposition_id uuid,org_id uuid NOT NULL,released_at timestamptz,PRIMARY KEY(batch_id,item_id),FOREIGN KEY(batch_id,org_id) REFERENCES dispatch_batches(id,org_id),FOREIGN KEY(disposition_id,item_id,org_id) REFERENCES disposition_requests(id,item_id,org_id));
CREATE UNIQUE INDEX one_batch_per_active_item ON dispatch_batch_items(item_id) WHERE released_at IS NULL;

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES dispatch_batches,
  weight_g int NOT NULL CHECK(weight_g>0),
  state text NOT NULL,
  packed_media_ids uuid[] NOT NULL,
  handed_by uuid REFERENCES users(id),
  shipped_at timestamptz,
  returned_at timestamptz,
  UNIQUE(id,batch_id)
);

CREATE TABLE shipment_items(shipment_id uuid,batch_id uuid NOT NULL,item_id uuid,PRIMARY KEY(batch_id,item_id),FOREIGN KEY(shipment_id,batch_id) REFERENCES shipments(id,batch_id),FOREIGN KEY(batch_id,item_id) REFERENCES dispatch_batch_items(batch_id,item_id));

CREATE TABLE shipping_rate_versions (
  id uuid PRIMARY KEY, version integer NOT NULL UNIQUE, rules jsonb NOT NULL,
  effective_at timestamptz NOT NULL, published_by uuid NOT NULL REFERENCES users(id)
);

CREATE TABLE dispatch_quote_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES dispatch_batches,
  revision int NOT NULL,
  snapshot jsonb NOT NULL,
  rate_version_id uuid REFERENCES shipping_rate_versions,
  amount_cents int NOT NULL CHECK(amount_cents>=0),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  UNIQUE(batch_id,revision)
);

CREATE TABLE storage_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disposition_id uuid NOT NULL REFERENCES disposition_requests,
  revision int NOT NULL,
  snapshot jsonb NOT NULL,
  amount_cents int NOT NULL CHECK(amount_cents>=0),
  expires_at timestamptz NOT NULL,
  UNIQUE(disposition_id,revision)
);

CREATE TABLE charge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations,
  purpose text NOT NULL,
  inspection_quote_id uuid UNIQUE REFERENCES inspection_quotes,
  dispatch_quote_id uuid UNIQUE REFERENCES dispatch_quote_versions,
  storage_quote_id uuid UNIQUE REFERENCES storage_quotes,
  amount_cents int NOT NULL CHECK(amount_cents>=0),
  currency text NOT NULL CHECK(currency='USD'),
  snapshot jsonb NOT NULL,
  applied_payment_id uuid UNIQUE,
  voided_at timestamptz,
  CHECK(num_nonnulls(inspection_quote_id,dispatch_quote_id,storage_quote_id)=1),
  CHECK((purpose='inspection' AND inspection_quote_id IS NOT NULL) OR (purpose='dispatch' AND dispatch_quote_id IS NOT NULL) OR (purpose='storage' AND storage_quote_id IS NOT NULL))
);

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  charge_item_id uuid NOT NULL REFERENCES charge_items, provider_data jsonb NOT NULL DEFAULT jsonb_build_object(),
  provider text NOT NULL CHECK (provider = 'stripe'),
  provider_ref text,
  amount_cents int NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'USD',
  state text NOT NULL DEFAULT 'requires_payment' CHECK (state IN ('requires_payment','processing','succeeded','failed','canceled','partially_refunded','refunded')),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);

ALTER TABLE payments ADD UNIQUE(id,charge_item_id);
ALTER TABLE charge_items ADD FOREIGN KEY(applied_payment_id,id) REFERENCES payments(id,charge_item_id);

CREATE TABLE payment_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  event_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, event_id)
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  source text NOT NULL,
  amount_cents int NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','approved','succeeded','failed','rejected')),
  requested_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX stripe_refund ON refunds(provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE order_blocks (
  id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), reason text NOT NULL, object_key text NOT NULL,
  opened_at timestamptz NOT NULL, resolved_at timestamptz
);

CREATE UNIQUE INDEX active_block ON order_blocks(order_id,reason,object_key) WHERE resolved_at IS NULL;

CREATE TABLE carriers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  provider_code text NOT NULL UNIQUE,
  labels jsonb NOT NULL,
  phone_rule jsonb,
  tracking_pattern text,
  enabled boolean NOT NULL DEFAULT false,
  verified_at timestamptz
);

CREATE TABLE tracking_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations,
  direction text NOT NULL,
  advice_id uuid REFERENCES package_advices,
  package_id uuid REFERENCES packages,
  shipment_id uuid REFERENCES shipments,
  carrier_code text REFERENCES carriers(code),
  tracking_norm text NOT NULL,
  generation int NOT NULL,
  parent_tracker_id uuid REFERENCES tracking_records,
  supersedes_id uuid REFERENCES tracking_records,
  source_phone_ciphertext bytea,
  transport_state text NOT NULL,
  sync_state text NOT NULL,
  latest_event_at timestamptz,
  last_success_at timestamptz,
  next_query_at timestamptz,
  closed_at timestamptz,
  revision int NOT NULL DEFAULT 1,
  CHECK(num_nonnulls(advice_id,package_id,shipment_id)>=1)
);

CREATE UNIQUE INDEX active_waybill ON tracking_records(carrier_code,tracking_norm) WHERE closed_at IS NULL AND carrier_code IS NOT NULL;

CREATE TABLE tracking_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_id uuid NOT NULL REFERENCES tracking_records,
  provider text NOT NULL,
  callback_token text UNIQUE NOT NULL,
  salt_ciphertext bytea NOT NULL,
  credential_version text NOT NULL,
  status text NOT NULL,
  attempt_count int NOT NULL DEFAULT 0,
  last_error_code text,
  next_retry_at timestamptz
);

CREATE UNIQUE INDEX active_subscription ON tracking_subscriptions(tracker_id,provider) WHERE status IN ('pending','active');

CREATE TABLE tracking_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES tracking_subscriptions,
  payload_sha256 text NOT NULL,
  received_at timestamptz NOT NULL,
  encrypted_payload bytea,
  verified_at timestamptz NOT NULL,
  processed_at timestamptz,
  attempt_count int NOT NULL DEFAULT 0,
  error_code text,
  UNIQUE(subscription_id,payload_sha256)
);

CREATE TABLE tracking_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_id uuid NOT NULL REFERENCES tracking_records,
  source text NOT NULL,
  locale text NOT NULL,
  payload_hash text NOT NULL,
  fetched_at timestamptz NOT NULL,
  latest_event_at timestamptz,
  provider_state text,
  events_json jsonb NOT NULL,
  schema_version int NOT NULL,
  UNIQUE(tracker_id,source,locale,payload_hash)
);

CREATE TABLE tracking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_id uuid NOT NULL REFERENCES tracking_records,
  fingerprint text NOT NULL,
  source_time text,
  occurred_at timestamptz,
  source_timezone text,
  status_code text,
  location_code text,
  text_zh text,
  source_snapshot_id uuid NOT NULL REFERENCES tracking_snapshots,
  UNIQUE(tracker_id,fingerprint)
);

CREATE TABLE tracking_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES tracking_events,
  source_hash text NOT NULL,
  locale text NOT NULL,
  body text NOT NULL,
  source text NOT NULL,
  reviewer_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  UNIQUE(event_id,source_hash,locale)
);

CREATE TABLE tracking_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_id uuid NOT NULL REFERENCES tracking_records,
  kind text NOT NULL,
  episode int NOT NULL,
  state text NOT NULL,
  assignee_id uuid REFERENCES users(id),
  due_at timestamptz,
  ticket_id uuid REFERENCES tickets,
  last_notified_at timestamptz,
  UNIQUE(tracker_id,kind,episode)
);

CREATE TABLE tracking_query_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  carrier_code text NOT NULL,
  tracking_norm text NOT NULL,
  requested_locale text NOT NULL,
  reserved_at timestamptz NOT NULL,
  completed_at timestamptz,
  outcome text
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  order_id uuid REFERENCES orders,
  template text NOT NULL,
  locale text NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  read_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications,
  address_snapshot bytea NOT NULL,
  provider_message_id text,
  attempt int NOT NULL,
  state text NOT NULL,
  updated_at timestamptz NOT NULL,
  error_code text,
  UNIQUE(notification_id,attempt)
);

CREATE TABLE email_webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_key text NOT NULL,
  payload_ciphertext bytea,
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  UNIQUE(provider,event_key)
);

CREATE TABLE stocktakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope jsonb NOT NULL,
  snapshot_at timestamptz NOT NULL,
  operator_id uuid NOT NULL REFERENCES users,
  state text NOT NULL
);

CREATE TABLE stocktake_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id uuid NOT NULL REFERENCES stocktakes,
  item_id uuid NOT NULL REFERENCES warehouse_items,
  expected_location uuid REFERENCES storage_locations,
  actual_location uuid REFERENCES storage_locations,
  revision int NOT NULL,
  evidence jsonb,
  state text NOT NULL,
  UNIQUE(stocktake_id,item_id)
);

CREATE TABLE inventory_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_item_id uuid NOT NULL REFERENCES stocktake_items,
  reason text NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  requested_by uuid NOT NULL REFERENCES users,
  approved_by uuid REFERENCES users(id),
  CHECK(approved_by<>requested_by)
);

CREATE TABLE incident_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES warehouse_items,
  ticket_id uuid NOT NULL REFERENCES tickets,
  order_line_id uuid REFERENCES order_lines,
  evidence jsonb NOT NULL,
  state text NOT NULL,
  resolution jsonb,
  payment_proof jsonb
);

CREATE TABLE disposal_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations,
  state text NOT NULL,
  revision int NOT NULL,
  policy_snapshot jsonb NOT NULL,
  authorization_snapshot jsonb,
  requested_by uuid NOT NULL REFERENCES users,
  approved_by uuid REFERENCES users(id),
  execution_evidence jsonb,
  CHECK(approved_by<>requested_by)
);

CREATE TABLE disposal_items(case_id uuid REFERENCES disposal_cases,item_id uuid REFERENCES warehouse_items,PRIMARY KEY(case_id,item_id));

-- Tenant and lifecycle invariants shared across API commands.
ALTER TABLE customer_receiving_profiles ADD UNIQUE(user_id,org_id),
  ADD FOREIGN KEY(user_id,org_id) REFERENCES memberships(user_id,org_id);
ALTER TABLE package_advices ADD FOREIGN KEY(user_id,org_id) REFERENCES customer_receiving_profiles(user_id,org_id);
ALTER TABLE packages ADD UNIQUE(id,org_id), ADD FOREIGN KEY(advice_id,org_id) REFERENCES package_advices(id,org_id);
ALTER TABLE warehouse_items ADD FOREIGN KEY(package_id,org_id) REFERENCES packages(id,org_id);
ALTER TABLE shipments ADD COLUMN carrier_code text, ADD COLUMN tracking_norm text,
  ADD CHECK (state NOT IN ('shipped','delivered','returned') OR
    (shipped_at IS NOT NULL AND handed_by IS NOT NULL AND length(trim(tracking_norm))>0 AND tracking_norm IS NOT NULL AND carrier_code IS NOT NULL));
ALTER TABLE tracking_records ADD CHECK(direction IN ('inbound','outbound_forward','outbound_domestic','outbound_return','carrier_return')),
  ADD CHECK ((direction='inbound' AND shipment_id IS NULL) OR (direction<>'inbound' AND shipment_id IS NOT NULL));
CREATE TABLE charge_allocations(
  charge_id uuid REFERENCES charge_items, order_id uuid REFERENCES orders, amount_cents integer NOT NULL CHECK(amount_cents>=0),
  PRIMARY KEY(charge_id,order_id)
);
CREATE TABLE payment_disputes(
  provider_id text PRIMARY KEY, payment_id uuid NOT NULL REFERENCES payments,
  state text NOT NULL, evidence_due_at timestamptz, updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX one_open_attempt ON payments(charge_item_id) WHERE state IN ('requires_payment','processing');
CREATE TABLE storage_periods(
  id uuid PRIMARY KEY, item_id uuid NOT NULL REFERENCES warehouse_items,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
  charge_id uuid UNIQUE REFERENCES charge_items, policy_snapshot jsonb NOT NULL
);
CREATE TABLE scope_revisions(
  id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders, revision integer NOT NULL, previous_snapshot jsonb NOT NULL,
  proposed_snapshot jsonb NOT NULL, reason text NOT NULL, accepted_by uuid REFERENCES users,
  accepted_at timestamptz, adjustment_cents integer NOT NULL, UNIQUE(order_id,revision)
);
CREATE TABLE recovery_requests(
  id uuid PRIMARY KEY, user_id uuid REFERENCES users, target_ciphertext bytea NOT NULL,
  evidence_ticket_id uuid NOT NULL REFERENCES tickets, state text NOT NULL, verified_at timestamptz,
  requested_by uuid REFERENCES users, approved_by uuid REFERENCES users, execute_after timestamptz,
  executed_at timestamptz, CHECK(approved_by<>requested_by)
);
CREATE TABLE recovery_runs(
  id uuid PRIMARY KEY, restored_to timestamptz NOT NULL, started_at timestamptz NOT NULL,
  finished_at timestamptz, reconciliation jsonb NOT NULL, approved_by uuid REFERENCES users
);
ALTER TABLE report_versions ADD CHECK (
  state NOT IN ('published','superseded') OR (reviewed_by IS NOT NULL AND reviewed_by<>created_by
  AND pdf_key IS NOT NULL AND pdf_sha256 IS NOT NULL AND published_at IS NOT NULL));
CREATE FUNCTION reject_history_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable record in %', TG_TABLE_NAME USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_history_write();
CREATE TRIGGER immutable_logistics BEFORE UPDATE OR DELETE ON tracking_snapshots FOR EACH ROW EXECUTE FUNCTION reject_history_write();
CREATE FUNCTION protect_published_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('published','superseded') THEN
    IF TG_OP='UPDATE' THEN
      IF OLD.state='published' AND NEW.state='superseded' AND to_jsonb(NEW)-'state'=to_jsonb(OLD)-'state' THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'published report' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER freeze_report BEFORE UPDATE OR DELETE ON report_versions FOR EACH ROW EXECUTE FUNCTION protect_published_report();
CREATE FUNCTION protect_published_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('PUBLISHED','DEPRECATED','RETIRED') THEN
    IF TG_OP='UPDATE' THEN
      IF NEW.state IN ('DEPRECATED','RETIRED') AND NEW.state<>OLD.state AND OLD.state<>'RETIRED'
        AND to_jsonb(NEW)-'state'=to_jsonb(OLD)-'state' THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'published template' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER freeze_template BEFORE UPDATE OR DELETE ON template_versions FOR EACH ROW EXECUTE FUNCTION protect_published_template();

ALTER TABLE report_shares ADD COLUMN report_version_id uuid NOT NULL REFERENCES report_versions;
ALTER TABLE shipments ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE report_versions ADD COLUMN revision integer NOT NULL DEFAULT 1, ADD UNIQUE(id,report_id);
ALTER TABLE report_shares ADD FOREIGN KEY(report_version_id,report_id) REFERENCES report_versions(id,report_id);
ALTER TABLE refunds ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE refunds ADD CHECK(source IN ('platform','provider_dashboard') AND (source='provider_dashboard' OR requested_by IS NOT NULL));
ALTER TABLE order_lines ADD COLUMN draft_items jsonb NOT NULL DEFAULT '[]';
ALTER TABLE scope_revisions ADD UNIQUE(id,order_id);
ALTER TABLE charge_items ADD COLUMN scope_revision_id uuid UNIQUE REFERENCES scope_revisions;
-- An approved upward scope change uses its own new inspection quote. Original applied charges remain immutable.
CREATE UNIQUE INDEX one_active_task_item ON inspection_tasks(assignment_id) WHERE assignment_id IS NOT NULL AND state <> 'VOID';
CREATE UNIQUE INDEX one_active_task_group ON inspection_tasks(group_id) WHERE group_id IS NOT NULL AND state <> 'VOID';
CREATE INDEX worklist ON inspection_tasks(state,assignee_id);
CREATE INDEX org_items ON warehouse_items(org_id,custody_state);
CREATE INDEX lookup_waybill ON tracking_records(tracking_norm);
CREATE INDEX due_trackers ON tracking_records(next_query_at) WHERE closed_at IS NULL;
ALTER TABLE tracking_records ADD COLUMN revision_reason text;
CREATE TABLE reference_reservations(
  id uuid PRIMARY KEY, reference_id uuid NOT NULL REFERENCES reference_samples,
  group_id uuid NOT NULL REFERENCES inspection_groups, reserved_at timestamptz NOT NULL, released_at timestamptz
);
CREATE UNIQUE INDEX one_reference_use ON reference_reservations(reference_id) WHERE released_at IS NULL;
CREATE TABLE package_claims(
  id uuid PRIMARY KEY, package_id uuid NOT NULL REFERENCES packages, applicant_id uuid NOT NULL REFERENCES users,
  evidence_ids uuid[] NOT NULL, state text NOT NULL, reviewed_by uuid REFERENCES users, decided_at timestamptz
);
CREATE TABLE task_evidence(
  task_id uuid REFERENCES inspection_tasks, media_id uuid REFERENCES media_assets, item_key text NOT NULL,
  component text NOT NULL, PRIMARY KEY(task_id,media_id,item_key,component)
);
CREATE TABLE payment_settlements(
  provider_transaction_id text PRIMARY KEY, payment_id uuid NOT NULL REFERENCES payments,
  gross_minor bigint NOT NULL, fee_minor bigint NOT NULL, net_minor bigint NOT NULL,
  currency text NOT NULL, exchange_rate numeric, settled_at timestamptz
);

ALTER TABLE charge_items ADD COLUMN free_authorization jsonb;
ALTER TABLE refunds ADD CHECK(approved_by IS NULL OR requested_by IS DISTINCT FROM approved_by);
ALTER TABLE inspection_quotes ADD UNIQUE(id,order_id);
ALTER TABLE user_emails ADD CHECK(NOT is_primary OR verified_at IS NOT NULL);
CREATE TABLE manual_quote_requests(
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations,
  order_id uuid NOT NULL, revision integer NOT NULL, state text NOT NULL,
  assignee_id uuid REFERENCES users, due_at timestamptz NOT NULL,
  accepted_quote_id uuid REFERENCES inspection_quotes, reason text NOT NULL,
  FOREIGN KEY(order_id,org_id) REFERENCES orders(id,org_id),
  FOREIGN KEY(accepted_quote_id,order_id) REFERENCES inspection_quotes(id,order_id),
  UNIQUE(order_id,revision)
);
CREATE TABLE disposal_case_approvals(
  case_id uuid REFERENCES disposal_cases, revision integer NOT NULL, list_hash text NOT NULL,
  evidence jsonb NOT NULL, actor_id uuid NOT NULL REFERENCES users, approved_at timestamptz NOT NULL,
  PRIMARY KEY(case_id,revision)
);
ALTER TABLE tickets ADD COLUMN next_action_at timestamptz, ADD COLUMN resolution_evidence jsonb;
ALTER TABLE tickets DROP CONSTRAINT tickets_category_check;
ALTER TABLE tickets ADD CHECK(category IN ('identity_unclear','receipt_mismatch','measurement_dispute','return_info_incomplete','damage_or_loss','payment_refund','privacy_share','non_standard_quote','recovery','delivery_issue','tracking_exception','disposal'));
CREATE FUNCTION freeze_accepted_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'accepted quote' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER freeze_inspection_quote BEFORE UPDATE OR DELETE ON inspection_quotes FOR EACH ROW EXECUTE FUNCTION freeze_accepted_quote();
CREATE TRIGGER freeze_dispatch_quote BEFORE UPDATE OR DELETE ON dispatch_quote_versions FOR EACH ROW EXECUTE FUNCTION freeze_accepted_quote();
ALTER TABLE storage_quotes ADD COLUMN accepted_at timestamptz;
CREATE TRIGGER freeze_storage_quote BEFORE UPDATE OR DELETE ON storage_quotes FOR EACH ROW EXECUTE FUNCTION freeze_accepted_quote();

COMMIT;
