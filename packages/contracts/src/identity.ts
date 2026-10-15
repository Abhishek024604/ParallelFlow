import { z } from 'zod';

// Identity (openapi_v2.yaml: #/components/schemas/Me, PATCH /me). Doc 07 §7.1.

/** User handles: lower-case letters, digits, `_` and `-`, 3–30 characters. */
export const HANDLE_PATTERN = /^[a-z0-9_-]{3,30}$/;

export const OrgRoleSchema = z.enum([
  'owner',
  'admin',
  'security_admin',
  'billing_admin',
  'member',
  'guest',
]);

/** #/components/schemas/Organization. */
export const OrganizationSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    preset: z.enum(['startup', 'enterprise']),
    unit_level_names: z.array(z.string()),
    data_region: z.string(),
    sso_enabled: z.boolean(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type Organization = z.infer<typeof OrganizationSchema>;

/**
 * #/components/schemas/Me. `personal_agent` is optional in the contract and not returned yet
 * (SLICE_DEBT: personal agents are org-scoped and the MVP Private model is settled in F12-01).
 */
export const MeSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    display_name: z.string(),
    handle: z.string(),
    orgs: z.array(
      z
        .object({
          org: OrganizationSchema,
          role: OrgRoleSchema,
          status: z.string(),
          expires_at: z.string().datetime({ offset: true }).nullable(),
        })
        .strict(),
    ),
    unit_roles: z.array(
      z.object({ unit_id: z.string().uuid(), role: z.enum(['unit_lead', 'unit_admin']) }).strict(),
    ),
  })
  .strict();
export type Me = z.infer<typeof MeSchema>;

/** PATCH /me body. At least one field; unknown fields are rejected. */
export const UpdateMeSchema = z
  .object({
    display_name: z.string().trim().min(1, 'Required').max(80, 'At most 80 characters').optional(),
    handle: z
      .string()
      .trim()
      .toLowerCase()
      .regex(HANDLE_PATTERN, '3–30 of a–z, 0–9, _ and -')
      .optional(),
  })
  .strict()
  .refine((body) => body.display_name !== undefined || body.handle !== undefined, {
    message: 'Send display_name, handle or both',
  });
export type UpdateMe = z.infer<typeof UpdateMeSchema>;
