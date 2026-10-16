import { MyFiles } from '../../../../components/my-files';
import { getPrivateFiles } from '../../../../lib/api-server';

export const metadata = { title: 'My files · Saras' };

// My files (build step 6): your private markdown files, newest first.
export default async function MyFilesPage() {
  const files = await getPrivateFiles();
  return <MyFiles files={files.items} />;
}
