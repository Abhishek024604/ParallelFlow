import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Put,
} from '@nestjs/common';
import {
  type ConnectLinear,
  ConnectLinearSchema,
  type ExtensionKey,
  type ExtensionList,
  isExtensionKey,
} from '@parallelflow/contracts';
import type { Tx } from '@parallelflow/db';
import { Caller, DbTx } from '../pipeline/decorators.js';
import { notFound, validationFailed } from '../pipeline/errors.js';
import type { CallerContext } from '../pipeline/request-context.js';
import { CONNECTION_KEY } from '../pipeline/tokens.js';
import { ZodPipe } from '../pipeline/validation.js';
import {
  install,
  linearLabel,
  listExtensions,
  removeConnection,
  saveConnection,
  uninstall,
} from './extensions.js';

// Private extensions marketplace (ADR-039). Unscoped routes: the pipeline opens a user-scope
// transaction, so RLS shows the caller's own rows only. Mutations need CSRF (AuthGuard).
//   GET    /private/extensions                 the catalog, what you installed, your connections
//   PUT    /private/extensions/:key            install (idempotent)
//   DELETE /private/extensions/:key            uninstall (its documents stay)
//   PUT    /private/connections/linear         connect Linear with a personal API key (checked once)
//   DELETE /private/connections/linear         disconnect

/** An installable extension key from the path; anything else (unknown, "soon") is 404. */
function extensionKey(value: string): ExtensionKey {
  if (!isExtensionKey(value)) throw notFound();
  return value;
}

@Controller('private')
export class ExtensionsController {
  constructor(@Inject(CONNECTION_KEY) private readonly key: Buffer) {}

  @Get('extensions')
  @Header('Cache-Control', 'no-store')
  async list(@DbTx() tx: Tx, @Caller() caller: CallerContext): Promise<ExtensionList> {
    return listExtensions(tx, caller.userId);
  }

  @Put('extensions/:key')
  @Header('Cache-Control', 'no-store')
  async install(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('key') key: string,
  ): Promise<ExtensionList> {
    await install(tx, caller.userId, extensionKey(key));
    return listExtensions(tx, caller.userId);
  }

  @Delete('extensions/:key')
  @Header('Cache-Control', 'no-store')
  async uninstall(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('key') key: string,
  ): Promise<ExtensionList> {
    await uninstall(tx, caller.userId, extensionKey(key));
    return listExtensions(tx, caller.userId);
  }

  @Put('connections/linear')
  @Header('Cache-Control', 'no-store')
  async connectLinear(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Body(new ZodPipe(ConnectLinearSchema)) body: ConnectLinear,
  ): Promise<ExtensionList> {
    const label = await linearLabel(body.api_key);
    if (!label) {
      throw validationFailed(
        [{ field: 'api_key', message: 'Linear did not accept this key' }],
        'Linear did not accept this key.',
      );
    }
    await saveConnection(tx, this.key, caller.userId, {
      provider: 'linear',
      secret: body.api_key,
      label,
    });
    return listExtensions(tx, caller.userId);
  }

  @Delete('connections/linear')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async disconnectLinear(@DbTx() tx: Tx, @Caller() caller: CallerContext): Promise<ExtensionList> {
    await removeConnection(tx, caller.userId, 'linear');
    return listExtensions(tx, caller.userId);
  }
}
