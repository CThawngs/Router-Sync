import { describe, it, expect } from 'vitest';
import { ComboSpecSchema } from '../../cli/src/config/schema';
import { parse } from '../../cli/node_modules/yaml';

describe('UI-COMBO: YAML Preview & CLI Schema Conformance', () => {
  it('validates generated preview YAML matches the real CLI ComboSpecSchema', () => {
    // Generate YAML matching the CombosScreen preview logic
    const previewModels = {
      isFree: true,
      included: [
        { prov: 'kite', id: 'kite-code-3' },
        { prov: 'lumen', id: 'lumen-flash-2' },
        { prov: 'nova', id: 'nova-chat-1' },
      ],
    };
    const strategy = 'pri';
    const traitCtx = true;

    const yamlStr = `name: custom-preview
role: ${strategy === 'pri' ? 'priority' : strategy === 'rr' ? 'round-robin' : 'latency'}
routers:
  - omniroute
size: ${previewModels.included.length}
constraints:
  freeOnly: ${previewModels.isFree}${traitCtx ? '\n  minContext: 100000' : ''}
pin:
${previewModels.included.map((m) => `  - ${m.prov}/${m.id}`).join('\n')}
`;

    // 1. Must parse cleanly as valid YAML
    const parsed = parse(yamlStr);
    expect(parsed).toBeDefined();
    expect(parsed.name).toBe('custom-preview');
    expect(parsed.size).toBe(3);

    // 2. Must satisfy CLI's ComboSpecSchema
    const validation = ComboSpecSchema.safeParse(parsed);
    expect(validation.success, `Schema validation failed: ${JSON.stringify(validation)}`).toBe(true);
    if (validation.success) {
      expect(validation.data.routers).toContain('omniroute');
      expect(validation.data.constraints.freeOnly).toBe(true);
      expect(validation.data.constraints.minContext).toBe(100000);
      expect(validation.data.pin).toHaveLength(3);
    }
  });
});
