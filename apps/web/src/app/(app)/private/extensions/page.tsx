import { Extensions } from '../../../../components/extensions';
import { getExtensions } from '../../../../lib/api-server';

export const metadata = { title: 'Extensions · ParallelFlow' };

// Extensions (ADR-039): specialist workflows for your private AI. Installing one turns it on in all
// of your private chats; the arena's AI stays general.
export default async function ExtensionsPage() {
  const list = await getExtensions();
  return <Extensions initial={list} />;
}
