import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AiKeyCard } from '../../../components/ai-key-card';
import { getAiProviders, getMyAiKey } from '../../../lib/api-server';

// Settings (avatar menu): your own AI key for your private chats (ADR-043).

export const metadata: Metadata = { title: 'Settings · ParallelFlow' };

export default async function SettingsPage() {
  const [key, providers] = await Promise.all([getMyAiKey(), getAiProviders()]);
  if (!key) notFound();
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <section aria-labelledby="settings-ai" className="mx-auto max-w-[720px] px-6 pt-8 pb-12">
        <h1 className="text-[22px] font-bold text-text">Settings</h1>
        <h2 id="settings-ai" className="mt-6 text-[15px] font-semibold text-text">
          AI provider
        </h2>
        <AiKeyCard
          title="Your AI key"
          description="Use your own OpenAI, Claude, DeepSeek, OpenRouter or other key in your private chats."
          path="/me/ai-key"
          initial={key}
          providers={providers}
        />
      </section>
    </main>
  );
}
