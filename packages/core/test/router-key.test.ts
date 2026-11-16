import { describe, it, expect } from 'vitest';
import { resolveRouterKey, ROUTER_KEY_CANDIDATES } from '../src/index.js';

describe('resolveRouterKey (least privilege router key resolution)', () => {
  const CANARY_SECRET = 'secret-canary-never-expose-in-output-xyz789';

  describe('9Router key hierarchy', () => {
    it('resolves NINEROUTER_CLIENT_KEY as client scope', () => {
      const res = resolveRouterKey('9router', { NINEROUTER_CLIENT_KEY: CANARY_SECRET });
      expect(res).toEqual({ name: 'NINEROUTER_CLIENT_KEY', scope: 'client' });
      expect(JSON.stringify(res)).not.toContain(CANARY_SECRET);
    });

    it('resolves NINE_ROUTER_CLIENT_KEY as client scope', () => {
      const res = resolveRouterKey('9router', { NINE_ROUTER_CLIENT_KEY: CANARY_SECRET });
      expect(res).toEqual({ name: 'NINE_ROUTER_CLIENT_KEY', scope: 'client' });
      expect(JSON.stringify(res)).not.toContain(CANARY_SECRET);
    });

    it('resolves NINEROUTER_ADMIN_KEY as elevated scope', () => {
      const res = resolveRouterKey('9router', { NINEROUTER_ADMIN_KEY: CANARY_SECRET });
      expect(res).toEqual({ name: 'NINEROUTER_ADMIN_KEY', scope: 'elevated' });
    });

    it('resolves NINEROUTER_API_KEY as elevated scope', () => {
      const res = resolveRouterKey('9router', { NINEROUTER_API_KEY: CANARY_SECRET });
      expect(res).toEqual({ name: 'NINEROUTER_API_KEY', scope: 'elevated' });
    });

    it('resolves NINE_ROUTER_API_KEY as elevated scope', () => {
      const res = resolveRouterKey('9router', { NINE_ROUTER_API_KEY: CANARY_SECRET });
      expect(res).toEqual({ name: 'NINE_ROUTER_API_KEY', scope: 'elevated' });
    });

    it('prefers client key over elevated key (least privilege)', () => {
      const res = resolveRouterKey('9router', {
        NINEROUTER_ADMIN_KEY: 'admin-secret',
        NINE_ROUTER_CLIENT_KEY: 'client-secret',
      });
      expect(res).toEqual({ name: 'NINE_ROUTER_CLIENT_KEY', scope: 'client' });
    });

    it('prefers NINEROUTER_CLIENT_KEY over NINE_ROUTER_CLIENT_KEY', () => {
      const res = resolveRouterKey('9router', {
        NINE_ROUTER_CLIENT_KEY: 'val2',
        NINEROUTER_CLIENT_KEY: 'val1',
      });
      expect(res).toEqual({ name: 'NINEROUTER_CLIENT_KEY', scope: 'client' });
    });

    it('filters strictly by scope when requested', () => {
      const env = {
        NINE_ROUTER_CLIENT_KEY: 'client-val',
        NINE_ROUTER_API_KEY: 'elevated-val',
      };
      const clientOnly = resolveRouterKey('9router', env, { scope: 'client' });
      expect(clientOnly).toEqual({ name: 'NINE_ROUTER_CLIENT_KEY', scope: 'client' });

      const elevatedOnly = resolveRouterKey('9router', env, { scope: 'elevated' });
      expect(elevatedOnly).toEqual({ name: 'NINE_ROUTER_API_KEY', scope: 'elevated' });
    });

    it('normalizes adapter name aliases (nine, 9router, 9-router)', () => {
      expect(resolveRouterKey('nine', { NINEROUTER_CLIENT_KEY: 'k' })?.name).toBe('NINEROUTER_CLIENT_KEY');
      expect(resolveRouterKey('9-router', { NINEROUTER_CLIENT_KEY: 'k' })?.name).toBe('NINEROUTER_CLIENT_KEY');
    });
  });

  describe('OmniRoute key hierarchy', () => {
    it('resolves OMNIROUTE_CLIENT_KEY as client scope', () => {
      const res = resolveRouterKey('omniroute', { OMNIROUTE_CLIENT_KEY: CANARY_SECRET });
      expect(res).toEqual({ name: 'OMNIROUTE_CLIENT_KEY', scope: 'client' });
    });

    it('resolves OMNIROUTE_ADMIN_KEY as elevated scope', () => {
      const res = resolveRouterKey('omniroute', { OMNIROUTE_ADMIN_KEY: CANARY_SECRET });
      expect(res).toEqual({ name: 'OMNIROUTE_ADMIN_KEY', scope: 'elevated' });
    });

    it('resolves OMNIROUTE_API_KEY as elevated scope fallback', () => {
      const res = resolveRouterKey('omniroute', { OMNIROUTE_API_KEY: CANARY_SECRET });
      expect(res).toEqual({ name: 'OMNIROUTE_API_KEY', scope: 'elevated' });
    });

    it('prefers OMNIROUTE_CLIENT_KEY over OMNIROUTE_ADMIN_KEY by default', () => {
      const res = resolveRouterKey('omniroute', {
        OMNIROUTE_CLIENT_KEY: 'c',
        OMNIROUTE_ADMIN_KEY: 'a',
      });
      expect(res).toEqual({ name: 'OMNIROUTE_CLIENT_KEY', scope: 'client' });
    });

    it('filters by elevated scope for full read-back', () => {
      const res = resolveRouterKey(
        'omniroute',
        { OMNIROUTE_CLIENT_KEY: 'c', OMNIROUTE_API_KEY: 'a' },
        { scope: 'elevated' }
      );
      expect(res).toEqual({ name: 'OMNIROUTE_API_KEY', scope: 'elevated' });
    });

    it('normalizes adapter name alias (omni, omniroute)', () => {
      expect(resolveRouterKey('omni', { OMNIROUTE_CLIENT_KEY: 'k' })?.name).toBe('OMNIROUTE_CLIENT_KEY');
    });
  });

  describe('Edge cases and safety', () => {
    it('returns null when no keys are defined', () => {
      expect(resolveRouterKey('9router', {})).toBeNull();
      expect(resolveRouterKey('omniroute', {})).toBeNull();
    });

    it('ignores empty and whitespace-only values', () => {
      expect(resolveRouterKey('9router', { NINEROUTER_CLIENT_KEY: '   ', NINE_ROUTER_API_KEY: '' })).toBeNull();
    });

    it('returns null for unknown adapters', () => {
      expect(resolveRouterKey('unknown_adapter', { SOME_KEY: 'secret' })).toBeNull();
    });

    it('canary assertion: returned object contains zero secret data', () => {
      const canary = 'CANARY_NEVER_LEAK_PLAINTEXT';
      const resolved = resolveRouterKey('9router', { NINEROUTER_CLIENT_KEY: canary });
      expect(resolved).not.toBeNull();
      expect(Object.values(resolved!)).not.toContain(canary);
      expect(JSON.stringify(resolved)).not.toContain(canary);
    });
  });
});
