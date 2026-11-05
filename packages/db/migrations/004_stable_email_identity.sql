ALTER TABLE user_emails ADD UNIQUE (id, user_id);
ALTER TABLE auth_identities ADD COLUMN email_id uuid;

UPDATE auth_identities AS identity
SET email_id = email.id, subject = email.id::text
FROM user_emails AS email
WHERE identity.provider = 'email_otp'
  AND identity.issuer = 'qcwarehouse'
  AND identity.user_id = email.user_id
  AND identity.subject::citext = email.normalized_email
  AND email.login_enabled AND email.verified_at IS NOT NULL;

ALTER TABLE auth_identities
  ADD FOREIGN KEY (email_id, user_id) REFERENCES user_emails(id, user_id),
  ADD CHECK (
    (email_id IS NULL AND (provider <> 'email_otp' OR status <> 'active'))
    OR
    (provider = 'email_otp' AND issuer = 'qcwarehouse'
      AND email_id IS NOT NULL AND subject = email_id::text)
  );
