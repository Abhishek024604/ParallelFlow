-- Reverts 0010_user_extensions. Dev only: installs and connected services are lost.
SET search_path = saras, public;

DROP TABLE IF EXISTS user_connections;
DROP TABLE IF EXISTS user_extensions;
