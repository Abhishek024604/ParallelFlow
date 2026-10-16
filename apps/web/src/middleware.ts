import { type NextRequest, NextResponse } from 'next/server';
import { serverApiUrl } from './lib/config';
import { safeReturnPath, signInPath } from './lib/paths';
import { applyToCookieHeader, type CookieUpdate, parseSetCookie } from './lib/set-cookie';

// Session gate for every page (ADR-032). Calls GET /v1/me with the browser's cookies:
//   200  signed in. Any refreshed cookie the API returns is passed on to the browser and to the
//        server components rendering this request (so they call the API with the fresh one).
//   401  signed out. App pages redirect to /sign-in?return_to=<path>; the sign-in and join pages
//        render signed out.
// The sign-in page sends people who are already signed in to their return path.
// This is the one place the Next server can set cookies for a page load, so it is where WorkOS
// refreshes reach the browser (server components cannot set cookies). /v1/* is not gated here: it
// is the same-origin API proxy (next.config.ts), whose Set-Cookie headers go straight through.

const SESSION_COOKIE = 'saras_session';
const ME_HEADER = 'x-saras-me';

function isPublicPath(pathname: string): boolean {
  return pathname === '/sign-in' || pathname.startsWith('/join/');
}

function setCookieLines(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname, search, searchParams } = req.nextUrl;

  // Failed logins come back to the web root with ?auth_error= (ADR-032): show them on sign-in.
  if (pathname === '/' && searchParams.has('auth_error')) {
    const url = req.nextUrl.clone();
    url.pathname = '/sign-in';
    return NextResponse.redirect(url);
  }

  const publicPath = isPublicPath(pathname);
  const cookieHeader = req.headers.get('cookie') ?? '';
  const toSignIn = () =>
    NextResponse.redirect(new URL(signInPath(`${pathname}${search}`), req.url));

  if (!req.cookies.has(SESSION_COOKIE)) {
    if (!publicPath) return toSignIn();
    const headers = new Headers(req.headers);
    headers.delete(ME_HEADER);
    return NextResponse.next({ request: { headers } });
  }

  let me: Response;
  try {
    me = await fetch(`${serverApiUrl()}/v1/me`, {
      headers: { cookie: cookieHeader, accept: 'application/json' },
      cache: 'no-store',
    });
  } catch {
    // API unreachable: let the page render and show its own error.
    const headers = new Headers(req.headers);
    headers.delete(ME_HEADER);
    return NextResponse.next({ request: { headers } });
  }

  const lines = setCookieLines(me);
  const updates = lines.map((line) => parseSetCookie(line)).filter((u): u is CookieUpdate => !!u);

  // Render this request with the cookies the browser will have once it applies the updates.
  // Hand the profile to server components (getMe) so they do not ask the API for it again. Set
  // only here, from the API's answer; whatever a client sent under this name is dropped.
  const meBody = me.ok ? await me.text().catch(() => undefined) : undefined;
  const next = () => {
    const headers = new Headers(req.headers);
    headers.delete(ME_HEADER);
    if (meBody) headers.set(ME_HEADER, encodeURIComponent(meBody));
    if (updates.length) headers.set('cookie', applyToCookieHeader(cookieHeader, updates));
    return NextResponse.next({ request: { headers } });
  };

  let res: NextResponse;
  if (me.status === 401) {
    res = publicPath ? next() : toSignIn();
  } else if (me.ok && pathname === '/sign-in') {
    res = NextResponse.redirect(new URL(safeReturnPath(searchParams.get('return_to')), req.url));
  } else {
    res = next();
  }
  for (const line of lines) res.headers.append('set-cookie', line);
  return res;
}

export const config = {
  // Pages only: not the /v1 API proxy, not Next's assets, not files in /public.
  matcher: ['/((?!v1/|_next/|favicon|google\\.svg|.*\\.(?:svg|png|ico|txt)$).*)'],
};
