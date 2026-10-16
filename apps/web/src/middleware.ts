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

const SESSION_COOKIE = 'saras_session';

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
    return publicPath ? NextResponse.next() : toSignIn();
  }

  let me: Response;
  try {
    me = await fetch(`${serverApiUrl()}/v1/me`, {
      headers: { cookie: cookieHeader, accept: 'application/json' },
      cache: 'no-store',
    });
  } catch {
    // API unreachable: let the page render and show its own error.
    return NextResponse.next();
  }

  const lines = setCookieLines(me);
  const updates = lines.map((line) => parseSetCookie(line)).filter((u): u is CookieUpdate => !!u);

  // Render this request with the cookies the browser will have once it applies the updates.
  const next = () => {
    const headers = new Headers(req.headers);
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
  // Pages only: not Next's assets, not files in /public.
  matcher: ['/((?!_next/|favicon|google\\.svg|.*\\.(?:svg|png|ico|txt)$).*)'],
};
