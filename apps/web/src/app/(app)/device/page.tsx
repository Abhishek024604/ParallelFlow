import type { Metadata } from 'next';
import { DeviceApproval } from '../../../components/device-approval';

// Connect VS Code (ADR-037): approve the code the extension shows, and see or revoke connected apps.

export const metadata: Metadata = { title: 'Connect VS Code · Saras' };

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { code } = await searchParams;
  return <DeviceApproval initialCode={typeof code === 'string' ? code.slice(0, 20) : ''} />;
}
