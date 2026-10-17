import { Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  type ListNotificationsQuery,
  ListNotificationsQuerySchema,
  type NotificationPage,
} from '@saras/contracts';
import type { Tx } from '@saras/db';
import { Caller, DbTx } from '../pipeline/decorators.js';
import { notFound } from '../pipeline/errors.js';
import { type CallerContext, isUuid } from '../pipeline/request-context.js';
import { ZodPipe } from '../pipeline/validation.js';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './notifications.js';

// The Inbox (C9). User-scope routes (no project in the path): the reads run per arena in each org's
// verified tenant context (notifications.ts). Marking read changes nothing else, so a repeat is
// harmless and the routes take no Idempotency-Key; they are mutations, so CSRF is checked.
//   GET  /me/notifications                ?filter=all|action|unread&limit=&cursor=  newest first
//   POST /me/notifications/:id/read       one
//   POST /me/notifications/read-all       all of yours

@Controller('me/notifications')
export class NotificationsController {
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Query(new ZodPipe(ListNotificationsQuerySchema)) query: ListNotificationsQuery,
  ): Promise<NotificationPage> {
    return listNotifications(tx, caller.userId, query);
  }

  @Post('read-all')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async readAll(@DbTx() tx: Tx, @Caller() caller: CallerContext): Promise<{ updated: number }> {
    return { updated: await markAllNotificationsRead(tx, caller.userId) };
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
  ): Promise<void> {
    if (!isUuid(id)) throw notFound();
    await markNotificationRead(tx, caller.userId, id.toLowerCase());
  }
}
