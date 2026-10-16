import { redirect } from 'next/navigation';
import { HOME_PATH } from '../lib/config';

// `/` → Arena mode. Signed-out visitors never get here: the middleware sends them to /sign-in.
export default function RootPage() {
  redirect(HOME_PATH);
}
