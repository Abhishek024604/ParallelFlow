import type { ReactNode } from 'react';
import { Illustration, Logo } from '../../components/brand';
import { LockIcon, SparkIcon, UsersIcon } from '../../components/icons';
import { authErrorMessage, loginUrl, safeReturnPath } from '../../lib/paths';

export const metadata = { title: 'Sign in · ParallelFlow' };

// Sign up / log in (screen 11). Every button goes to the hosted WorkOS AuthKit page through the
// API's /v1/auth/login, which comes back to `return_to`. The inline name/email/password form of the
// mock is not built (SLICE_DEBT): AuthKit collects those. No top bar on this page.

function Feature({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span className="card inline-flex h-8 w-8 shrink-0 items-center justify-center text-muted">
        {icon}
      </span>
      <span>
        <span className="block font-semibold text-text">{title}</span>
        <span className="block text-muted">{children}</span>
      </span>
    </li>
  );
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnPath(params.return_to);
  const error = authErrorMessage(params.auth_error);
  const joining = returnTo.startsWith('/join/');

  return (
    <div className="grid min-h-dvh lg:grid-cols-[670fr_770fr]">
      <section className="hidden flex-col bg-sand px-16 py-16 lg:flex">
        <Logo size={40} />
        <div className="my-auto max-w-[460px]">
          <Illustration width={150} />
          <h1 className="mt-14 text-[48px] font-bold leading-[1.08] tracking-[-0.025em] text-text">
            Build with your team <span className="hl">and AI</span>, in one place.
          </h1>
          <ul className="mt-9 space-y-5 text-[14px]">
            <Feature icon={<UsersIcon size={15} />} title="Arenas for your team">
              One shared space per project: chat, files and tasks.
            </Feature>
            <Feature icon={<SparkIcon size={13} />} title="AI that works with everyone">
              Mention the AI in an arena and it helps the whole team.
            </Feature>
            <Feature icon={<LockIcon size={15} />} title="Private space for drafts">
              Work with AI on your own, then share when ready.
            </Feature>
          </ul>
        </div>
      </section>

      <section className="flex flex-col items-center justify-center px-6 py-16">
        <div className="mb-10 lg:hidden">
          <Logo size={36} />
        </div>
        <div className="w-full max-w-[420px]">
          <h2 className="text-[30px] font-bold text-text">Create your account</h2>
          <p className="mt-2 text-muted">Free while we&rsquo;re in beta. Takes a minute.</p>

          {error && (
            <p role="alert" className="chip bad mt-6 px-3 py-2.5 text-[13px]">
              {error}
            </p>
          )}

          <a
            href={loginUrl({ returnTo, provider: 'google' })}
            className="btn mt-6 h-11 w-full text-[15px]"
          >
            {/* Google's mark keeps its own colours, so it is an image, not a token-coloured icon. */}
            <img src="/google.svg" alt="" width={18} height={18} />
            Continue with Google
          </a>

          <div className="my-6 flex items-center gap-3 text-[12px] text-faint">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>

          <a
            href={loginUrl({ returnTo, screen: 'sign-up' })}
            className="btn pri h-12 w-full text-[15px]"
          >
            Create account
          </a>
          <p className="mt-5 text-center text-muted">
            Already have an account? <a href={loginUrl({ returnTo, screen: 'sign-in' })}>Log in</a>
          </p>
          <p className="mt-6 text-center text-[12px] text-faint">
            {joining
              ? 'Sign up or log in with the email your invitation was sent to. You’ll come straight back to join.'
              : 'Got an invitation? Sign up with the email it was sent to, then open the link again.'}
          </p>
        </div>
      </section>
    </div>
  );
}
