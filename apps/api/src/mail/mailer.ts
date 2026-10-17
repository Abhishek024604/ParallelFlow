import type { Logger } from '@saras/observability';
import nodemailer from 'nodemailer';

// Outgoing email (Phase A: nodemailer over SMTP; SLICE_DEBT: SES + templates, doc 05). Off unless
// SMTP_URL is set, e.g. smtps://user:app-password@smtp.gmail.com:465, or smtp://localhost:1025 for
// Mailpit (docker compose). MAIL_FROM is the sender ("Saras <you@example.com>"). Sending happens after
// the transaction commits and never fails the request. Addresses, links and bodies are never logged.

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** Resolves true when the server accepted the message. Never throws. */
  send(mail: Mail): Promise<boolean>;
}

export function smtpMailer(env: { url: string; from: string }, logger: Logger): Mailer {
  const transport = nodemailer.createTransport(env.url);
  return {
    async send(mail) {
      try {
        await transport.sendMail({ from: env.from, ...mail });
        return true;
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.name : 'Error' }, 'email not sent');
        return false;
      }
    },
  };
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "<inviter> invited you to <arena> on Saras" with the join link. */
export function inviteMail(input: {
  to: string;
  inviter: string;
  arena: string;
  link: string;
}): Mail {
  const { inviter, arena, link } = input;
  return {
    to: input.to,
    subject: `${inviter} invited you to ${arena} on Saras`,
    text: `${inviter} invited you to join the arena "${arena}" on Saras.\n\nJoin here: ${link}\n\nSign up or log in with this email address (${input.to}), then you'll come straight back to join. The link works for 7 days.`,
    html: `<p>${escape(inviter)} invited you to join the arena <strong>${escape(arena)}</strong> on Saras.</p>
<p><a href="${escape(link)}">Join ${escape(arena)}</a></p>
<p>Sign up or log in with this email address (${escape(input.to)}), then you'll come straight back to join. The link works for 7 days.</p>`,
  };
}
