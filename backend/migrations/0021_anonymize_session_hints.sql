UPDATE sessions_v2
SET ref_hint = 'session-' || LEFT(REPLACE(id::text, '-', ''), 8);
