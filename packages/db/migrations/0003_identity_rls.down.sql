-- Reverts 0003_identity_rls.
SET search_path = saras, public;

DROP POLICY IF EXISTS member_projects ON projects;
DROP POLICY IF EXISTS own_project_memberships ON project_members;
DROP POLICY IF EXISTS own_org_memberships ON org_memberships;

DROP POLICY IF EXISTS orgs_update ON organizations;
DROP POLICY IF EXISTS orgs_insert ON organizations;
DROP POLICY IF EXISTS orgs_read ON organizations;
ALTER TABLE organizations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organizations DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_update ON users;
DROP POLICY IF EXISTS users_insert ON users;
DROP POLICY IF EXISTS users_read ON users;
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS saras.is_system_job();
DROP FUNCTION IF EXISTS saras.current_auth_email();
DROP FUNCTION IF EXISTS saras.in_user_scope();
DROP FUNCTION IF EXISTS saras.current_org_id();
DROP FUNCTION IF EXISTS saras.current_user_id();
