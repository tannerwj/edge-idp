ALTER TABLE access_requests ADD COLUMN decision_note TEXT;
ALTER TABLE access_requests ADD COLUMN previous_end INTEGER;
ALTER TABLE access_requests ADD COLUMN approved_until INTEGER;
UPDATE access_requests SET approved_until=(SELECT expires_at FROM temporary_app_grants WHERE id='temporary:'||access_requests.id)
 WHERE decision='approved';
CREATE INDEX idx_requests_member ON access_requests(user_id,requested_at);
