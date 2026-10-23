import type { Metadata } from 'next';
import { InboxList } from '../../../components/inbox-list';

// The Inbox (screen 10): every notification across your arenas. The list loads on the client.

export const metadata: Metadata = { title: 'Inbox · ParallelFlow' };

export default function InboxPage() {
  return <InboxList />;
}
