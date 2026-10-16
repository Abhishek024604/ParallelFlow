-- ADR-034 (extended for the bridge, build step 6): private artifacts, their versions and their file
-- content belong to no org either. A private artifact is reachable only by its owner in user scope
-- (db.withUser); arena (org) rows keep tenant RLS exactly as schema_v2 defines it. No existing policy
-- is edited or dropped: the three policies below are new PERMISSIVE private_space_* ones in the 0006
-- style, and schema_v2's RESTRICTIVE private_artifacts_owner_only still applies (it passes for the
-- owner's own private rows).
--
-- Blob keys. schema_v2 keys blobs by (org_id, sha256) and artifact_versions points at them with a
-- composite FK. A primary key column cannot be NULL, so:
--   * blobs gets a surrogate uuid primary key `id` (also the public file id of an upload);
--   * org blobs stay unique on (org_id, sha256) (a UNIQUE constraint now backs the original FK);
--   * private blobs carry owner_user_id instead of org_id and are unique on (owner_user_id, sha256);
--   * artifact_versions gets blob_owner_user_id and a second composite FK to (owner_user_id, sha256).
-- Both FKs are MATCH SIMPLE, so each covers exactly one kind of row (a NULL column skips the check).
-- Real FKs give integrity for both kinds without a trigger. One trigger ties a version to its
-- artifact's owner (org or user), which no FK can express.
--
-- Phase A stores file content in Postgres (`content bytea`); `s3_key` becomes nullable and exactly
-- one of the two is set (SLICE_DEBT: move to S3, ADR-024).

SET search_path = saras, public;

-- ---------------------------------------------------------------- artifacts
ALTER TABLE artifacts ALTER COLUMN org_id DROP NOT NULL;
-- Strict: a private artifact has no org, an arena artifact always has one. Any org-scoped private
-- artifact (an old fixture) fails here and must be removed first; the dev seed has none.
ALTER TABLE artifacts ADD CONSTRAINT artifacts_private_no_org
  CHECK ((scope = 'private') = (org_id IS NULL));

-- ---------------------------------------------------------------- blobs
DO $$
DECLARE fk text;
BEGIN
  SELECT c.conname INTO fk FROM pg_constraint c
   WHERE c.conrelid = 'saras.artifact_versions'::regclass AND c.contype = 'f'
     AND c.confrelid = 'saras.blobs'::regclass;
  IF fk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE saras.artifact_versions DROP CONSTRAINT %I', fk);
  END IF;
END $$;

ALTER TABLE blobs DROP CONSTRAINT blobs_pkey;
ALTER TABLE blobs ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE blobs ADD CONSTRAINT blobs_pkey PRIMARY KEY (id);
ALTER TABLE blobs ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE blobs ADD COLUMN owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
-- File name of the first upload of this content (uploads only; artifact versions use the artifact name).
ALTER TABLE blobs ADD COLUMN name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 255);
ALTER TABLE blobs ADD COLUMN content bytea;
ALTER TABLE blobs ALTER COLUMN s3_key DROP NOT NULL;

ALTER TABLE blobs ADD CONSTRAINT blobs_org_or_owner CHECK ((org_id IS NULL) = (owner_user_id IS NOT NULL));
ALTER TABLE blobs ADD CONSTRAINT blobs_one_store CHECK (num_nonnulls(content, s3_key) = 1);
-- In-database content: at most 10 MB (uploads, doc 10 §10.5 Phase A) and size_bytes is its length.
ALTER TABLE blobs ADD CONSTRAINT blobs_content_size
  CHECK (content IS NULL OR (octet_length(content) = size_bytes AND size_bytes <= 10485760));
ALTER TABLE blobs ADD CONSTRAINT blobs_org_sha256 UNIQUE (org_id, sha256);
ALTER TABLE blobs ADD CONSTRAINT blobs_owner_sha256 UNIQUE (owner_user_id, sha256);

-- ---------------------------------------------------------------- artifact versions
ALTER TABLE artifact_versions ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE artifact_versions ADD COLUMN blob_owner_user_id uuid;
ALTER TABLE artifact_versions ADD CONSTRAINT artifact_versions_org_or_owner
  CHECK ((org_id IS NULL) = (blob_owner_user_id IS NOT NULL));
ALTER TABLE artifact_versions ADD CONSTRAINT artifact_versions_org_blob_fkey
  FOREIGN KEY (org_id, blob_sha256) REFERENCES blobs (org_id, sha256);
ALTER TABLE artifact_versions ADD CONSTRAINT artifact_versions_private_blob_fkey
  FOREIGN KEY (blob_owner_user_id, blob_sha256) REFERENCES blobs (owner_user_id, sha256);

-- A version belongs to its artifact's owner: the same org, or (private) the artifact owner's blobs.
-- Runs as the inserting role under RLS: whoever may write the version can see its artifact.
CREATE FUNCTION artifact_version_matches_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  SELECT org_id, owner_user_id, scope INTO a FROM saras.artifacts WHERE id = NEW.artifact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'artifact % is not visible', NEW.artifact_id USING ERRCODE = '23503';
  END IF;
  IF NEW.org_id IS DISTINCT FROM a.org_id
     OR (a.scope = 'private' AND NEW.blob_owner_user_id IS DISTINCT FROM a.owner_user_id) THEN
    RAISE EXCEPTION 'artifact version must have its artifact''s owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
-- Not on org_id updates: RLS already rejects moving a row to another org (tenant_isolation and
-- private_space_* WITH CHECK), with 42501 as the tenant suite expects. The same policies keep an
-- artifact's org and private owner fixed, so artifacts need no trigger of their own.
CREATE TRIGGER artifact_versions_match_artifact
  BEFORE INSERT OR UPDATE OF artifact_id, blob_owner_user_id ON artifact_versions
  FOR EACH ROW EXECUTE FUNCTION artifact_version_matches_artifact();

-- ---------------------------------------------------------------- owner-only policies for org-less rows
-- All gated on user scope, so no tenant context (even the owner's own) and no system job sees them.

CREATE POLICY private_space_artifacts ON artifacts FOR ALL
  USING (org_id IS NULL AND saras.in_user_scope() AND scope = 'private'
         AND owner_user_id = saras.current_user_id())
  WITH CHECK (org_id IS NULL AND saras.in_user_scope() AND scope = 'private'
         AND owner_user_id = saras.current_user_id() AND project_id IS NULL
         -- Filed under one of your own chats only (RLS on private_sessions).
         AND (private_session_id IS NULL
              OR EXISTS (SELECT 1 FROM private_sessions ps
                         WHERE ps.id = artifacts.private_session_id
                           AND ps.owner_user_id = saras.current_user_id())));

CREATE POLICY private_space_artifact_versions ON artifact_versions FOR ALL
  USING (org_id IS NULL AND saras.in_user_scope()
         AND EXISTS (SELECT 1 FROM artifacts a
                     WHERE a.id = artifact_versions.artifact_id AND a.org_id IS NULL
                       AND a.owner_user_id = saras.current_user_id()))
  WITH CHECK (org_id IS NULL AND saras.in_user_scope()
         AND blob_owner_user_id = saras.current_user_id()
         AND EXISTS (SELECT 1 FROM artifacts a
                     WHERE a.id = artifact_versions.artifact_id AND a.org_id IS NULL
                       AND a.owner_user_id = saras.current_user_id()));

CREATE POLICY private_space_blobs ON blobs FOR ALL
  USING (org_id IS NULL AND saras.in_user_scope() AND owner_user_id = saras.current_user_id())
  WITH CHECK (org_id IS NULL AND saras.in_user_scope() AND owner_user_id = saras.current_user_id());
