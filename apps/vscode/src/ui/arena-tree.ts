// The "Arena" tree view beside the chat: the arena and its stage, the GitHub repository, the current
// task and branch, and the Architecture (SWA) gates with their files and diagrams. Approving a gate
// is an inline action (parallelflow.approveGate, confirmed in a modal by the controller).
import * as vscode from 'vscode';
import type { ArchitectView, ViewState } from '../shared/messages.js';

type Node = vscode.TreeItem & { children?: Node[] };

const GATE_LABEL: Record<string, string> = {
  approved: 'Approved',
  open: 'Open',
  empty: 'Not started',
};
const FILE_LABEL: Record<string, string> = {
  approved: 'approved',
  changed: 'changed since approval',
  stale: 'stale',
  draft: 'draft',
};

function item(
  label: string,
  opts: {
    icon?: string;
    description?: string;
    tooltip?: string;
    command?: vscode.Command;
    contextValue?: string;
    children?: Node[];
    expanded?: boolean;
  } = {},
): Node {
  const state = opts.children?.length
    ? opts.expanded
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None;
  const n: Node = new vscode.TreeItem(label, state);
  if (opts.icon) n.iconPath = new vscode.ThemeIcon(opts.icon);
  if (opts.description) n.description = opts.description;
  if (opts.tooltip) n.tooltip = opts.tooltip;
  if (opts.command) n.command = opts.command;
  if (opts.contextValue) n.contextValue = opts.contextValue;
  if (opts.children) n.children = opts.children;
  return n;
}

/** The gate key of an inline "Approve" on a gate row. */
export function gateOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  const id = (arg as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && id.startsWith('gate:') ? id.slice(5) : undefined;
}

const open = (rel: string): vscode.Command => ({
  command: 'parallelflow.openArchFile',
  title: 'Open',
  arguments: [rel],
});

function architecture(a: ArchitectView, mode: ViewState['mode']): Node {
  const gates = a.gates.map((g) => {
    const children: Node[] = g.files.map((f) =>
      item(f.path, {
        icon: 'file',
        description: FILE_LABEL[f.state] ?? f.state,
        command: open(f.path),
      }),
    );
    if (g.state !== 'empty') {
      for (const m of g.missing)
        children.push(item(m, { icon: 'circle-slash', description: 'missing' }));
    }
    const n = item(g.key, {
      icon:
        g.state === 'approved'
          ? 'pass-filled'
          : g.state === 'open'
            ? 'circle-large-outline'
            : 'circle-outline',
      description: GATE_LABEL[g.state] ?? g.state,
      contextValue: g.approvable ? 'gate.approvable' : 'gate',
      children,
      expanded: g.state === 'open',
    });
    n.id = `gate:${g.key}`;
    return n;
  });
  const children: Node[] = [...gates];
  if (a.inputs.missing.length) {
    children.unshift(
      item('Inputs missing', {
        icon: 'warning',
        description: a.inputs.missing.map((p) => `arch/${p}`).join(', '),
      }),
    );
  }
  if (a.diagrams.length) {
    children.push(
      item('Diagrams', {
        icon: 'type-hierarchy',
        children: a.diagrams.map((d) => item(d, { icon: 'file-media', command: open(d) })),
      }),
    );
  }
  children.push(item(`Next: ${a.next}`, { icon: 'arrow-right', tooltip: a.next }));
  const n = item(mode === 'architect' ? 'Architecture · Architect mode' : 'Architecture', {
    icon: 'symbol-structure',
    children,
    expanded: true,
  });
  n.id = 'architecture';
  return n;
}

export class ArenaTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  static readonly viewId = 'parallelflow.arena';
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: Node[] = [];
  private sig = '';

  update(s: ViewState): void {
    const sig = JSON.stringify([
      s.signedIn,
      s.arena,
      s.githubRepo,
      s.task,
      s.architecture,
      s.mode,
      s.agent.status,
    ]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.roots = this.build(s);
    this.changed.fire(undefined);
  }

  private build(s: ViewState): Node[] {
    if (!s.signedIn) {
      return [
        item('Sign in to ParallelFlow', {
          icon: 'account',
          command: { command: 'parallelflow.signIn', title: 'Sign in' },
        }),
      ];
    }
    const out: Node[] = [];
    out.push(
      s.arena
        ? item(s.arena.name, {
            icon: 'organization',
            description: s.arena.stage
              ? `${s.arena.stage}${s.arena.cycle ? ` · cycle ${s.arena.cycle}` : ''}`
              : undefined,
            tooltip: `Arena ${s.arena.name}`,
          })
        : item('Link this folder to an arena', {
            icon: 'link',
            command: { command: 'parallelflow.linkArena', title: 'Link' },
          }),
    );
    if (s.githubRepo) {
      out.push(
        item(s.githubRepo, {
          icon: 'github',
          description: 'GitHub',
          command: {
            command: 'parallelflow.openExternal',
            title: 'Open on GitHub',
            arguments: [`https://github.com/${s.githubRepo}`],
          },
        }),
      );
    }
    if (s.task) {
      const t = s.task;
      const children: Node[] = [
        item(t.branch, { icon: 'git-branch', description: t.pushed ? 'pushed' : 'local' }),
      ];
      if (t.pr) {
        children.push(
          item(`Pull request #${t.pr.number}`, {
            icon: 'git-pull-request',
            command: {
              command: 'parallelflow.openExternal',
              title: 'Open pull request',
              arguments: [t.pr.link],
            },
          }),
        );
      }
      out.push(item(t.title, { icon: 'tasklist', description: 'task', children, expanded: true }));
    } else if (s.arena) {
      out.push(
        item('Start a task', {
          icon: 'add',
          command: { command: 'parallelflow.startTask', title: 'Start task' },
        }),
      );
    }
    const started =
      s.architecture &&
      (s.architecture.inputs.present.length > 0 ||
        s.architecture.gates.some((g) => g.state !== 'empty'));
    if (s.architecture && (s.mode === 'architect' || started))
      out.push(architecture(s.architecture, s.mode));
    else if (s.mode === 'architect')
      out.push(item('Architecture: open a folder, then /swa init', { icon: 'symbol-structure' }));
    return out;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    return n;
  }

  getChildren(n?: Node): Node[] {
    return n ? (n.children ?? []) : this.roots;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
