-- Reverts 0013_github_pulls. Dev only: the mirrored GitHub pull requests are dropped (they stay on
-- GitHub); in-app pull requests are untouched.
SET search_path = saras, public;

DELETE FROM pull_requests WHERE github_number IS NOT NULL;

DROP INDEX pull_requests_one_open_per_branch;
CREATE UNIQUE INDEX pull_requests_one_open_per_branch ON pull_requests (project_id, branch)
  WHERE status IN ('open', 'approved', 'changes_requested');

ALTER TABLE pull_requests ALTER COLUMN author_user_id SET NOT NULL;
ALTER TABLE pull_requests
  DROP CONSTRAINT pull_requests_github_number_key,
  DROP CONSTRAINT pull_requests_merged_check,
  DROP CONSTRAINT pull_requests_author_check,
  DROP CONSTRAINT pull_requests_base_check,
  DROP CONSTRAINT pull_requests_branch_check,
  DROP CONSTRAINT pull_requests_github_shape,
  ADD CHECK (branch ~ '^ai/'),
  ADD CHECK (base = 'main'),
  ADD CHECK ((status = 'merged') = (merged_at IS NOT NULL AND merged_by IS NOT NULL AND merge_sha IS NOT NULL));

ALTER TABLE pull_requests
  DROP COLUMN author_login,
  DROP COLUMN head_ref,
  DROP COLUMN github_state,
  DROP COLUMN html_url,
  DROP COLUMN github_number;
