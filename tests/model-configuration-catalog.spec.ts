import { describe, expect, it } from 'vitest';

import {
  buildModelConfigurationCatalog,
  findModelConfiguration,
  resolveHadamardConfigurationModel,
} from '../src/config/modelConfigurationCatalog.js';

describe('model configuration catalog', () => {
  it('places the SDK default before GUI-compatible named configurations', () => {
    const catalog = buildModelConfigurationCatalog(
      { model: 'default-model', provider: 'anthropic' },
      [{
        name: 'review',
        runtime: 'reasonix',
        provider: 'openai',
        model: 'reasoning-large',
        models: [{ name: 'reasoning-small' }, { name: 'reasoning-large' }],
      }],
    );

    expect(catalog.map(item => item.id)).toEqual(['default', 'config:review']);
    expect(catalog[0]?.model).toBe('default-model');
    expect(catalog[1]?.models.map(model => model.name)).toEqual([
      'reasoning-large',
      'reasoning-small',
    ]);
    expect(findModelConfiguration(catalog, 'REVIEW')?.id).toBe('config:review');
    expect(findModelConfiguration(catalog, 'default')?.source).toBe('default');
  });

  it('resolves the model that the next Hadamard SDK request must receive', () => {
    const config = {
      name: 'local-review',
      runtime: 'hadamard' as const,
      provider: 'anthropic' as const,
      models: [{ name: 'review-model' }],
    };

    expect(resolveHadamardConfigurationModel(config, false)).toBe('review-model');
    expect(resolveHadamardConfigurationModel(config, false, 'selected-model')).toBe('selected-model');
    expect(resolveHadamardConfigurationModel(config, true, 'bridge-model')).toBeUndefined();
  });
});
