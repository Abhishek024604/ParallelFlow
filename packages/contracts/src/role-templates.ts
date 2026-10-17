import file from '../../../docs/contracts/role_templates_v2.json' with { type: 'json' };
import { type RoleTemplate, RoleTemplateFileSchema } from './roles.js';

// The role templates (docs/contracts/role_templates_v2.json, the source of truth), parsed and checked
// once at import. Server only (`@saras/contracts/role-templates`), so the web bundle never carries
// the file: the web app reads GET /v1/role-templates.

export const ROLE_TEMPLATES: readonly RoleTemplate[] = RoleTemplateFileSchema.parse(file).templates;

export function findRoleTemplate(key: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((t) => t.key === key);
}
