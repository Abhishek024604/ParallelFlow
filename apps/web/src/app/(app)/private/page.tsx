import { Illustration } from '../../../components/brand';
import { PrivateHomeComposer } from '../../../components/private-home-composer';
import { SoonTip } from '../../../components/soon';

export const metadata = { title: 'Private · Saras' };

const SUGGESTIONS = ['Draft a goal.md', 'Bring context from an Arena', 'Review my plan.md'];

// Private home (screen 01). Writing here starts a new private chat with your AI (build step 5).
// The suggestion chips need files and the bridge (step 6), so they stay disabled.
export default function PrivateHome() {
  return (
    <div className="mx-auto flex min-h-full max-w-[1000px] flex-col items-center justify-center px-8 py-12">
      <Illustration width={150} />
      <h1 className="mt-4 text-[56px] font-bold leading-none tracking-[-0.025em] text-text">
        Saras
      </h1>
      <p className="mt-5 text-[26px] text-muted">
        Let&rsquo;s build and <span className="hl">ship</span>.
      </p>

      <div className="mt-10 w-full">
        <PrivateHomeComposer />
      </div>
      <ul className="mt-3 flex flex-wrap justify-center gap-2" aria-label="Suggestions">
        {SUGGESTIONS.map((label) => (
          <li key={label} className="w-auto">
            <SoonTip side="bottom">
              <button
                type="button"
                aria-disabled="true"
                className="btn h-9 cursor-not-allowed px-3.5 text-[14px] opacity-55"
              >
                {label}
              </button>
            </SoonTip>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-center text-[13px] text-faint">
        Private chats are visible only to you. Share a file with your team using Push to Arena.
      </p>
    </div>
  );
}
