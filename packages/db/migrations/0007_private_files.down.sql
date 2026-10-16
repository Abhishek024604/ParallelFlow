-- Reverts 0007_private_files. Dev only: org-less private artifacts, their versions and blobs, and any
-- blob whose content is in the database (uploads, in-database versions) are deleted first, because
-- org_id and s3_key cannot be NOT NULL again while they exist. Fails if evidence points at one of
-- those versions (none exist before the gates step).
SET search_path = saras, public;

DROP POLICY IF EXISTS private_space_blobs ON blobs;
DROP POLICY IF EXISTS private_space_artifact_versions ON artifact_versions;
DROP POLICY IF EXISTS private_space_artifacts ON artifacts;

DROP TRIGGER IF EXISTS artifact_versions_match_artifact ON artifact_versions;
DROP FUNCTION IF EXISTS artifact_version_matches_artifact();

DELETE FROM artifact_versions v
 WHERE v.org_id IS NULL
    OR EXISTS (SELECT 1 FROM blobs b
               WHERE b.org_id = v.org_id AND b.sha256 = v.blob_sha256 AND b.s3_key IS NULL);
DELETE FROM artifacts WHERE org_id IS NULL;
DELETE FROM blobs WHERE org_id IS NULL OR s3_key IS NULL;

ALTER TABLE artifact_versions DROP CONSTRAINT IF EXISTS artifact_versions_private_blob_fkey;
ALTER TABLE artifact_versions DROP CONSTRAINT IF EXISTS artifact_versions_org_blob_fkey;
ALTER TABLE artifact_versions DROP CONSTRAINT IF EXISTS artifact_versions_org_or_owner;
ALTER TABLE artifact_versions DROP COLUMN IF EXISTS blob_owner_user_id;
ALTER TABLE artifact_versions ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE blobs DROP CONSTRAINT IF EXISTS blobs_owner_sha256;
ALTER TABLE blobs DROP CONSTRAINT IF EXISTS blobs_org_sha256;
ALTER TABLE blobs DROP CONSTRAINT IF EXISTS blobs_content_size;
ALTER TABLE blobs DROP CONSTRAINT IF EXISTS blobs_one_store;
ALTER TABLE blobs DROP CONSTRAINT IF EXISTS blobs_org_or_owner;
ALTER TABLE blobs ALTER COLUMN s3_key SET NOT NULL;
ALTER TABLE blobs DROP COLUMN IF EXISTS content;
ALTER TABLE blobs DROP COLUMN IF EXISTS name;
ALTER TABLE blobs DROP COLUMN IF EXISTS owner_user_id;
ALTER TABLE blobs ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE blobs DROP CONSTRAINT blobs_pkey;
ALTER TABLE blobs DROP COLUMN id;
ALTER TABLE blobs ADD CONSTRAINT blobs_pkey PRIMARY KEY (org_id, sha256);
ALTER TABLE artifact_versions
  ADD FOREIGN KEY (org_id, blob_sha256) REFERENCES blobs (org_id, sha256);

ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_private_no_org;
ALTER TABLE artifacts ALTER COLUMN org_id SET NOT NULL;
