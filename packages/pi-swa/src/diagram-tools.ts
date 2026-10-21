import {
  diagramDiff,
  type DiagramView,
  generatedUntouched,
  modelViews,
  picture,
  toDrawio,
  toExcalidraw,
  viewOfPath,
} from './diagrams.js';
import { normalizeArchPath } from './layout.js';
import { readModel } from './model.js';
import { snapshot } from './state.js';
import type { ArchStore } from './store.js';
import { planWrite } from './writes.js';

// swa_diagram_save and swa_diagram_sync: the HLD diagrams generated from model.yaml, saved through
// the same write rules as every other file, and never written over an architect's edits.

export interface SaveRequest {
  /** One view; default all of them (context, containers, deployment, every flow). */
  view?: DiagramView;
  flow?: string;
  /** drawio (default) or excalidraw (a whiteboard sketch in hld/sketches/). */
  format?: 'drawio' | 'excalidraw';
  /** Overwrite a diagram that was edited after it was generated (only when the architect agreed). */
  replace?: boolean;
}

export async function saveDiagrams(store: ArchStore, req: SaveRequest): Promise<string> {
  const parsed = await readModel(store);
  if (!parsed) return 'REFUSED: arch/model.yaml does not exist yet: write the model first.';
  const { model, problems } = parsed;
  if (!model.components.length) {
    return `REFUSED: model.yaml has no components.${problems.length ? ` Problems: ${problems.join('; ')}` : ''}`;
  }
  const format = req.format ?? 'drawio';
  const views = modelViews(model).filter(
    (v) =>
      !req.view ||
      (v.view === req.view && (req.view !== 'flow' || !req.flow || v.flow === req.flow)),
  );
  if (!views.length)
    return `REFUSED: the model has no ${req.view}${req.flow ? ` "${req.flow}"` : ''} view.`;
  const out: string[] = [];
  for (const v of views) {
    const path =
      format === 'excalidraw'
        ? v.path.replace(/^hld\//, 'hld/sketches/').replace(/\.drawio$/, '.excalidraw')
        : v.path;
    const pic = picture(model, v.view, v.flow);
    const text = format === 'excalidraw' ? toExcalidraw(pic) : toDrawio(pic, v.flow ?? v.view);
    const existing = await store.read(path);
    if (existing !== null && existing !== text && !req.replace) {
      const edited = format === 'drawio' ? !generatedUntouched(existing) : true;
      if (edited) {
        const diff = format === 'drawio' ? safeDiff(pic, existing) : [];
        out.push(
          `Kept arch/${path}: it was edited after it was generated.${diff.length ? ` It differs from the model: ${diff.join('; ')}.` : ' It matches the model.'} Update model.yaml to match the edits, or ask the architect before saving with replace.`,
        );
        continue;
      }
    }
    if (existing === text) {
      out.push(`arch/${path} is up to date.`);
      continue;
    }
    const plan = await planWrite(store, await snapshot(store), { path, content: text });
    if (!plan.ok) {
      out.push(`REFUSED arch/${path}: ${plan.error}`);
      continue;
    }
    await store.write(plan.path, plan.text);
    out.push(`${existing === null ? 'Created' : 'Updated'} arch/${path}.`);
  }
  if (problems.length) out.push(`The model has problems to fix: ${problems.join('; ')}.`);
  return out.join('\n');
}

function safeDiff(pic: ReturnType<typeof picture>, xml: string): string[] {
  try {
    return diagramDiff(pic, xml);
  } catch (err) {
    return [`the file could not be read (${(err as Error).message})`];
  }
}

export async function syncDiagram(store: ArchStore, raw: string): Promise<string> {
  const path = normalizeArchPath(raw);
  if (!path || !path.endsWith('.drawio'))
    return 'REFUSED: give the path of a .drawio file in arch/hld/.';
  const xml = await store.read(path);
  if (xml === null) return `arch/${path} does not exist.`;
  const parsed = await readModel(store);
  if (!parsed) return 'arch/model.yaml does not exist yet.';
  const view = viewOfPath(parsed.model, path);
  if (!view) return `arch/${path} is not one of the views generated from model.yaml.`;
  if (generatedUntouched(xml)) {
    const fresh = toDrawio(picture(parsed.model, view.view, view.flow), view.flow ?? view.view);
    return fresh === xml
      ? `arch/${path} is as generated and matches the model.`
      : `arch/${path} is as generated but the model changed since: save it again with swa_diagram_save.`;
  }
  const diff = safeDiff(picture(parsed.model, view.view, view.flow), xml);
  return diff.length
    ? `arch/${path} was edited and differs from model.yaml:\n${diff.map((d) => `- ${d}`).join('\n')}\nAsk the architect which is right; update model.yaml (swa_write) to adopt the edits.`
    : `arch/${path} was edited (layout or style only): it matches model.yaml.`;
}
