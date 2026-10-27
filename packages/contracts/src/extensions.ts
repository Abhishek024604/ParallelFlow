import { z } from 'zod';

// Extensions marketplace (ADR-039). Extensions give a person's private AI a specialist workflow
// (Software Architect, Product Manager, …). They live in the Private space only: a person installs
// one for all of their private chats; the arena's AI stays a general teammate. Until an extension is
// installed, its commands are plain messages to the general AI. The catalog is built in for the MVP
// (SLICE_DEBT.md): installing turns an extension on, nothing is downloaded.

export type ExtensionKey = 'swa' | 'pm';
export type ConnectionProvider = 'linear';

export interface ExtensionInfo {
  key: string;
  name: string;
  tagline: string;
  description: string;
  /** The slash command it adds to private chats. */
  command?: string;
  /** Optional outside services it can use once connected. */
  connections?: readonly ConnectionProvider[];
  /** Listed but not installable yet. */
  soon?: boolean;
}

export const EXTENSIONS: readonly ExtensionInfo[] = [
  {
    key: 'pm',
    name: 'Product Manager',
    tagline: 'From an idea to reviewed requirements, stories and a roadmap',
    description:
      'Captures evidence, outcomes and KPIs, writes testable requirements, shapes the MVP and roadmap, and breaks scope into stories with acceptance criteria. Can create and update Linear issues once connected.',
    command: 'pm',
    connections: ['linear'],
  },
  {
    key: 'swa',
    name: 'Software Architect',
    tagline: 'From requirements to a reviewed, versioned architecture',
    description:
      'Turns requirements into drivers, a stack with decision records, a high-level design with diagrams, component designs and design reviews, with your approval at each step.',
    command: 'swa',
  },
  {
    key: 'builder',
    name: 'Builder',
    tagline: 'Turns approved stories into working code',
    description: 'Plans, writes and reviews code against your stories and architecture.',
    soon: true,
  },
];

export const EXTENSION_KEYS: readonly ExtensionKey[] = ['swa', 'pm'];

export const isExtensionKey = (key: string): key is ExtensionKey =>
  (EXTENSION_KEYS as readonly string[]).includes(key);

/** GET /private/extensions. */
export interface ExtensionList {
  extensions: (ExtensionInfo & { installed: boolean })[];
  connections: { provider: ConnectionProvider; label: string; connected_at: string }[];
}

/** PUT /private/connections/linear: a Linear personal API key (Settings › Security & access). */
export const ConnectLinearSchema = z
  .object({
    api_key: z
      .string()
      .trim()
      .min(20, 'Paste your Linear API key')
      .max(200, 'That does not look like a Linear API key')
      .regex(/^[A-Za-z0-9_-]+$/, 'That does not look like a Linear API key'),
  })
  .strict();
export type ConnectLinear = z.infer<typeof ConnectLinearSchema>;
