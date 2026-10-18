// Dev Container awareness. The extension is a workspace extension, so in a container both it and
// Pi run inside the container: that is the real boundary for shell commands.
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Isolation } from '../shared/messages.js';

export async function detectIsolation(root: string | undefined): Promise<Isolation> {
  if (vscode.env.remoteName === 'dev-container' || vscode.env.remoteName === 'codespaces')
    return 'container';
  if (!root) return 'host';
  const exists = (p: string) =>
    fsp.access(p).then(
      () => true,
      () => false,
    );
  if (
    (await exists(path.join(root, '.devcontainer', 'devcontainer.json'))) ||
    (await exists(path.join(root, '.devcontainer.json')))
  ) {
    return 'host-container-available';
  }
  return 'host';
}

export async function reopenInContainer(): Promise<void> {
  const ext = vscode.extensions.getExtension('ms-vscode-remote.remote-containers');
  if (!ext) {
    const pick = await vscode.window.showWarningMessage(
      'Reopening in a container needs the Dev Containers extension.',
      'Install Dev Containers',
    );
    if (pick)
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        'ms-vscode-remote.remote-containers',
      );
    return;
  }
  await vscode.commands.executeCommand('remote-containers.reopenInContainer');
}

/** A minimal Node 22 container. Only written when the person asks, never over an existing file. */
export const DEVCONTAINER_JSON = `${JSON.stringify(
  {
    name: 'Saras workspace',
    image: 'mcr.microsoft.com/devcontainers/typescript-node:22',
    features: { 'ghcr.io/devcontainers/features/git:1': {} },
    customizations: { vscode: { extensions: ['saras.saras-vscode'] } },
    postCreateCommand: 'corepack enable || true',
    remoteUser: 'node',
  },
  null,
  2,
)}\n`;

export async function scaffoldDevContainer(root: string): Promise<vscode.Uri | undefined> {
  const file = path.join(root, '.devcontainer', 'devcontainer.json');
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, DEVCONTAINER_JSON, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      void vscode.window.showInformationMessage(
        'This folder already has .devcontainer/devcontainer.json.',
      );
      return vscode.Uri.file(file);
    }
    throw err;
  }
  return vscode.Uri.file(file);
}
