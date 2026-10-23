import { notFound } from 'next/navigation';
import { PrivateChatHeader, PrivateChatRoom } from '../../../../components/private-chat';
import {
  getMe,
  getPrivateChat,
  getPrivateMessages,
  getPrivateProjects,
} from '../../../../lib/api-server';

export const metadata = { title: 'Private · ParallelFlow' };

// One private chat (screen 02, build step 5). The server renders the latest messages; the client
// polls for newer ones and streams the AI. `?turn=` is the AI turn started from the private home.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PrivateChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ chatId: string }>;
  searchParams: Promise<{ turn?: string | string[]; bring?: string | string[] }>;
}) {
  const [{ chatId: rawId }, query] = await Promise.all([params, searchParams]);
  if (!UUID.test(rawId)) notFound();
  const chatId = rawId.toLowerCase();
  const [me, chat, messages, projects] = await Promise.all([
    getMe(),
    getPrivateChat(chatId),
    getPrivateMessages(chatId),
    getPrivateProjects(),
  ]);
  if (!me || !chat || !messages) notFound();
  const turn = typeof query.turn === 'string' && UUID.test(query.turn) ? query.turn : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PrivateChatHeader
        key={`${chat.id}:${chat.title ?? ''}`}
        chat={chat}
        projects={projects.items}
        autoBring={query.bring === '1' && !chat.bound_project}
      />
      <PrivateChatRoom
        key={chat.id}
        chatId={chat.id}
        initial={messages}
        viewerId={me.id}
        initialTurnId={turn}
      />
    </div>
  );
}
