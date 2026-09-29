ALTER TABLE "validation_log_manifest"
  ALTER COLUMN "byte_length" TYPE bigint USING "byte_length"::bigint;

ALTER TABLE "validation_log_manifest"
  ADD COLUMN "completion" text;

ALTER TABLE "validation_log_manifest"
  ADD CONSTRAINT "validation_log_manifest_completion_check"
  CHECK ("completion" IS NULL OR "completion" IN ('complete', 'interrupted', 'unavailable'));
