import path from 'node:path';

import { getHadamardProjectSessionDirectory } from '../config/projectSessionDirectory.js';
import { type DesignArtifactRepository, SqliteDesignArtifactRepository } from './designArtifactRepository.js';
import { DesignConfigurationStore, type DesignConfiguration } from './designConfiguration.js';
import { DesignDocumentStore } from './designDocumentStore.js';
import { DesignImportCommitService, type DesignImportAction } from './designImportCommitService.js';
import { DesignImportExportService, type DesignImportPreview, type DesignTransferDocument } from './designImportExportService.js';
import { DesignRenderService } from './designRenderService.js';
import { createDefaultDesignTemplateRegistry } from './designTemplateRegistry.js';
import {
  DEFAULT_DESIGN_THEMES,
  resolveDesignTheme,
  validateDesignThemeTokens,
  type DesignThemeTokens,
} from './designTheme.js';
import { EngineeringProfileService } from './engineeringProfileService.js';
import { ENGINEERING_PROFILES } from './engineeringProfiles.js';
import { parseDesignDocument } from './designSchema.js';

export interface DesignDocumentServiceOptions {
  generatorVersion?: string;
  artifacts?: DesignArtifactRepository;
}

export class DesignDocumentService {
  readonly store: DesignDocumentStore;
  readonly configurations: DesignConfigurationStore;
  readonly templates = createDefaultDesignTemplateRegistry();
  readonly themes = DEFAULT_DESIGN_THEMES;
  readonly profiles = ENGINEERING_PROFILES;
  readonly renderer = new DesignRenderService();
  readonly transfers: DesignImportExportService;
  readonly artifacts: DesignArtifactRepository;
  readonly imports: DesignImportCommitService;
  readonly engineeringProfiles: EngineeringProfileService;

  constructor(
    projectPath: string,
    homeDir: string,
    options: DesignDocumentServiceOptions = {},
  ) {
    this.store = new DesignDocumentStore(projectPath);
    const stateDirectory = getHadamardProjectSessionDirectory(projectPath, homeDir);
    this.configurations = new DesignConfigurationStore(stateDirectory);
    this.transfers = new DesignImportExportService(this.renderer, options.generatorVersion);
    this.artifacts = options.artifacts ?? new SqliteDesignArtifactRepository(
      path.join(stateDirectory, 'design-artifacts-v2.sqlite'),
    );
    this.imports = new DesignImportCommitService(this.store, this.configurations, this.artifacts);
    this.engineeringProfiles = new EngineeringProfileService(projectPath, this.store);
  }

  async configuration(): Promise<DesignConfiguration> {
    const snapshot = await this.store.inspect();
    const parsed = parseDesignDocument(snapshot.content);
    return this.configurations.ensure(parsed.frontmatter.template, parsed.frontmatter.theme);
  }

  async transferDocument(content?: string): Promise<DesignTransferDocument> {
    const snapshot = content === undefined ? await this.store.inspect() : undefined;
    const configuration = await this.configuration();
    const assets = await Promise.all(configuration.assets.map(async descriptor => {
      const artifact = await this.artifacts.get(`design-${descriptor.sha256}`);
      if (!artifact || artifact.checksum !== descriptor.sha256 || artifact.mediaType !== descriptor.mediaType) {
        throw new Error(`Design asset is unavailable or corrupted: ${descriptor.path}`);
      }
      return { path: descriptor.path, mediaType: descriptor.mediaType, bytes: artifact.bytes };
    }));
    return { markdown: content ?? snapshot!.content, configuration, assets };
  }

  async read() {
    const snapshot = await this.store.inspect();
    return {
      ...snapshot,
      parsed: parseDesignDocument(snapshot.content),
      configuration: await this.configuration(),
    };
  }

  async patch(content: string, expectedRevision?: string) {
    const savedPath = await this.store.write(content, { expectedRevision });
    const parsed = parseDesignDocument(content);
    const configuration = await this.configurations.ensure(parsed.frontmatter.template, parsed.frontmatter.theme);
    if (configuration.template.id !== parsed.frontmatter.template
      || configuration.theme.id !== parsed.frontmatter.theme) {
      await this.configurations.save({
        ...configuration,
        template: { id: parsed.frontmatter.template, version: parsed.frontmatter.templateVersion },
        theme: resolveDesignTheme(parsed.frontmatter.theme),
      });
    }
    return savedPath;
  }

  async patchConfiguration(patch: {
    templateId?: string;
    themeId?: string;
    themeTokens?: Partial<DesignThemeTokens>;
    sectionOrder?: string[];
    hiddenSections?: string[];
  }, expectedRevision?: string): Promise<DesignConfiguration> {
    const document = await this.store.inspect();
    if (expectedRevision && document.revision !== expectedRevision) {
      throw new Error('DESIGN.md changed since configuration was loaded.');
    }
    const current = await this.configuration();
    const templateId = patch.templateId ?? current.template.id;
    const template = this.templates.get(templateId);
    if (!template) throw new Error(`Unknown Design template: ${templateId}`);
    const themeId = patch.themeId ?? current.theme.id;
    const baseTheme = resolveDesignTheme(themeId);
    const allowedSections = new Set(template.sections.map(section => section.id));
    const sectionOrder = patch.sectionOrder ?? current.sections.order;
    const hiddenSections = patch.hiddenSections ?? current.sections.hidden;
    if (sectionOrder.some(id => !allowedSections.has(id)) || hiddenSections.some(id => !allowedSections.has(id))) {
      throw new Error('Design configuration refers to a section outside the selected template.');
    }
    const next: DesignConfiguration = {
      ...current,
      template: { id: template.id, version: template.version },
      theme: {
        id: baseTheme.id,
        tokens: validateDesignThemeTokens(patch.themeTokens ?? current.theme.tokens, baseTheme.tokens),
      },
      sections: { order: [...new Set(sectionOrder)], hidden: [...new Set(hiddenSections)] },
    };
    await this.configurations.save(next);
    return next;
  }

  async render(content: string) {
    const configuration = await this.configuration();
    return this.renderer.render(content, configuration.theme.tokens, configuration.sections);
  }

  previewImport(bytes: Buffer, fileName: string): DesignImportPreview {
    return this.transfers.preview(bytes, fileName);
  }

  async commitImport(
    bytes: Buffer,
    fileName: string,
    action: DesignImportAction,
    expectedRevision: string,
  ) {
    return this.imports.commit(this.previewImport(bytes, fileName), action, expectedRevision);
  }

  async attachReference(bytes: Buffer, fileName: string) {
    const preview = this.previewImport(bytes, fileName);
    if (preview.editable || (preview.kind !== 'reference-html' && preview.kind !== 'reference-pdf')) {
      throw new Error('Only validated read-only HTML or PDF references can be attached.');
    }
    return this.artifacts.putImmutable(
      preview.kind === 'reference-pdf' ? 'application/pdf' : 'text/html',
      bytes,
      { kind: 'design-reference', fileName, sourceChecksum: preview.checksum, importedAt: new Date().toISOString() },
    );
  }

}
