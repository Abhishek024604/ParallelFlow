import { notFound } from 'next/navigation';
import { PrivateFileView } from '../../../../../components/my-files';

export const metadata = { title: 'My files · Saras' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One private file: sanitised markdown, versions, edit, Push to Arena (build step 6).
export default async function PrivateFilePage({ params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  if (!UUID.test(fileId)) notFound();
  return <PrivateFileView fileId={fileId.toLowerCase()} />;
}
