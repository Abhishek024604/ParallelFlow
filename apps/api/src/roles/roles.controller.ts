import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  type ApplyTemplate,
  ApplyTemplateSchema,
  CAPABILITIES,
  type Capability,
  type CreateRole,
  CreateRoleSchema,
  type ProjectMember,
  type Role,
  type RoleList,
  type RoleTemplateList,
  type SetMemberRoles,
  SetMemberRolesSchema,
  type UpdateRole,
  UpdateRoleSchema,
} from '@saras/contracts';
import { findRoleTemplate, ROLE_TEMPLATES } from '@saras/contracts/role-templates';
import type { Tx } from '@saras/db';
import { Caller, DbTx, Idempotent, ProjectScoped } from '../pipeline/decorators.js';
import { notFound, validationFailed } from '../pipeline/errors.js';
import { CachedRead } from '../pipeline/read-cache.js';
import { type CallerContext, isUuid } from '../pipeline/request-context.js';
import { ZodPipe } from '../pipeline/validation.js';
import {
  applyTemplate,
  createRole,
  deleteRole,
  listRoles,
  type RoleScope,
  setMemberRoles,
  updateRole,
} from './roles.js';

// Custom roles (build step 8). openapi_v2.yaml listCapabilities, listRoleTemplates, listRoles,
// createRole, updateRole, deleteRole, setMemberRoles and applyRoleTemplate. Project routes are
// @ProjectScoped (membership verified, one tenant transaction); writes are CSRF-checked by the session
// verifier, and the pipeline drops this project's cached reads after they commit.

function pathId(value: string): string {
  if (!isUuid(value)) throw notFound();
  return value.toLowerCase();
}

function scope(caller: CallerContext, projectId: string): RoleScope {
  if (!caller.orgId) throw new Error('Project-scoped route without an org');
  return { projectId: projectId.toLowerCase(), orgId: caller.orgId, userId: caller.userId };
}

/** The fixed catalogue and the templates: the same for everyone signed in, no database. */
@Controller()
export class CatalogueController {
  @Get('capabilities')
  @Header('Cache-Control', 'private, max-age=300')
  capabilities(): { items: readonly Capability[] } {
    return { items: CAPABILITIES };
  }

  @Get('role-templates')
  @Header('Cache-Control', 'private, max-age=300')
  templates(): RoleTemplateList {
    return { items: [...ROLE_TEMPLATES] };
  }
}

@Controller('projects/:projectId')
@ProjectScoped('projectId')
export class RolesController {
  @CachedRead()
  @Get('roles')
  @Header('Cache-Control', 'no-store')
  list(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
  ): Promise<RoleList> {
    return listRoles(tx, scope(caller, projectId));
  }

  @Post('roles')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  create(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(CreateRoleSchema)) body: CreateRole,
  ): Promise<Role> {
    return createRole(tx, scope(caller, projectId), body);
  }

  @Post('roles\\:apply-template')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  apply(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(ApplyTemplateSchema)) body: ApplyTemplate,
  ): Promise<RoleList> {
    const template = findRoleTemplate(body.template_key);
    if (!template) {
      throw validationFailed([{ field: 'template_key', message: 'Unknown template' }]);
    }
    return applyTemplate(tx, scope(caller, projectId), template, body);
  }

  @Patch('roles/:roleId')
  @Header('Cache-Control', 'no-store')
  update(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('roleId') roleId: string,
    @Body(new ZodPipe(UpdateRoleSchema)) body: UpdateRole,
  ): Promise<Role> {
    return updateRole(tx, scope(caller, projectId), pathId(roleId), body);
  }

  @Delete('roles/:roleId')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async remove(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('roleId') roleId: string,
  ): Promise<void> {
    await deleteRole(tx, scope(caller, projectId), pathId(roleId));
  }

  @Patch('members/:userId')
  @Header('Cache-Control', 'no-store')
  setRoles(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body(new ZodPipe(SetMemberRolesSchema)) body: SetMemberRoles,
  ): Promise<ProjectMember> {
    return setMemberRoles(tx, scope(caller, projectId), pathId(userId), body);
  }
}
