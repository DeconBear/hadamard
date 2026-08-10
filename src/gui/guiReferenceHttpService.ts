import {
  findBrokenRefs,
  findUsages,
  type ReferenceEdge,
  type ReferenceKnownSets,
  type ReferenceTargetKind,
} from '../manager/referenceIndex.js';
import type { ReferenceDefinitionKind } from '../manager/referenceOperations.js';
import type {
  GuiReferenceHttpControllerPort,
  GuiReferenceHttpResult,
} from './guiReferenceHttpController.js';

export interface GuiReferenceSnapshot {
  index: ReferenceEdge[];
  known: ReferenceKnownSets;
}

export interface GuiReferenceHttpServiceHost {
  snapshot(): Promise<GuiReferenceSnapshot>;
  rename(
    kind: ReferenceDefinitionKind,
    oldName: string,
    newName: string,
  ): Promise<{ rewritten: string[]; state: unknown }>;
  repointModel(
    config: string,
    fromModel: string,
    toModel: string,
  ): Promise<{ rewritten: string[]; state: unknown }>;
  mutationError(error: unknown): GuiReferenceHttpResult;
}

function unavailable(error: unknown): GuiReferenceHttpResult {
  return {
    status: 503,
    body: {
      code: 'REFERENCE_INDEX_UNAVAILABLE',
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

export function createGuiReferenceHttpService(
  host: GuiReferenceHttpServiceHost,
): GuiReferenceHttpControllerPort {
  return {
    async list(kind, name) {
      try {
        const { index } = await host.snapshot();
        if (!kind && !name) return { status: 200, body: { edges: index } };
        const kinds: ReferenceTargetKind[] = ['config', 'agent', 'team', 'router', 'workflow-script'];
        if (!kinds.includes(kind as ReferenceTargetKind) || !name) {
          return {
            status: 400,
            body: { code: 'INVALID_REFERENCE_QUERY', error: 'Missing or invalid kind/name' },
          };
        }
        return {
          status: 200,
          body: { edges: findUsages(index, kind as ReferenceTargetKind, name) },
        };
      } catch (error) {
        return unavailable(error);
      }
    },
    async broken() {
      try {
        const { index, known } = await host.snapshot();
        return { status: 200, body: { edges: findBrokenRefs(index, known) } };
      } catch (error) {
        return unavailable(error);
      }
    },
    async rename(body) {
      try {
        const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
        if (!['config', 'agent', 'router', 'team'].includes(kind)) {
          return { status: 400, body: { error: 'Invalid kind (config|agent|router|team)' } };
        }
        const result = await host.rename(
          kind as ReferenceDefinitionKind,
          typeof body.oldName === 'string' ? body.oldName.trim() : '',
          typeof body.newName === 'string' ? body.newName.trim() : '',
        );
        return { status: 200, body: { ok: true, ...result } };
      } catch (error) {
        return host.mutationError(error);
      }
    },
    async repointModel(body) {
      try {
        const config = typeof body.config === 'string' ? body.config.trim() : '';
        const fromModel = typeof body.fromModel === 'string' ? body.fromModel.trim() : '';
        const toModel = typeof body.toModel === 'string' ? body.toModel.trim() : '';
        if (!config || !fromModel || !toModel) {
          return { status: 400, body: { error: 'Missing config/fromModel/toModel' } };
        }
        const result = await host.repointModel(config, fromModel, toModel);
        return { status: 200, body: { ok: true, ...result } };
      } catch (error) {
        return host.mutationError(error);
      }
    },
  };
}
