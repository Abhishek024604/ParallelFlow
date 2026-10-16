import { Illustration } from '../../../components/brand';
import { ArrowUpIcon, LockIcon, PlusIcon, SparkIcon } from '../../../components/icons';
import { SoonTip } from '../../../components/soon';

export const metadata = { title: 'Private · Saras' };

// Private home (screen 01). The composer is shown but disabled until private chats ship (step 5).
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
        <SoonTip side="top" label="Private chats are coming soon">
          <div
            aria-disabled="true"
            className="card w-full cursor-not-allowed px-5 pb-3 pt-4 shadow-card"
          >
            <label htmlFor="private-composer" className="sr-only">
              Message
            </label>
            <textarea
              id="private-composer"
              disabled
              rows={2}
              placeholder="Write something..."
              className="w-full cursor-not-allowed resize-none bg-transparent text-[16px] text-text outline-none placeholder:text-faint"
            />
            <div className="mt-2 flex items-center gap-2">
              <button type="button" disabled className="btn h-10 w-10" aria-label="Add a file">
                <PlusIcon />
              </button>
              <span className="chip inline-flex items-center gap-1.5 px-2.5 py-1 text-[13px]">
                <LockIcon size={13} />
                Not linked to an arena
              </span>
              <button type="button" disabled className="btn ml-auto h-10 gap-2 px-4">
                <SparkIcon size={14} className="text-ai" />
                Balanced
              </button>
              <button type="button" disabled className="btn pri h-11 w-11" aria-label="Send">
                <ArrowUpIcon />
              </button>
            </div>
          </div>
        </SoonTip>
      </div>
      <p className="mt-6 text-center text-[13px] text-faint">
        Private chats are visible only to you. Share a file with your team using Push to Arena.
      </p>
    </div>
  );
}
