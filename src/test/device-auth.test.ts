/**
 * Tests for device auth standalone functions (Ed25519 key management, signing, token caching).
 *
 * Uses real crypto (no mocking) and temp directories for file I/O.
 * These functions are the building blocks for the gateway client's device auth flow
 * introduced for OpenClaw v2026.3.23+ scope enforcement (GHSA-rqpp-rjj8-7wv8).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify, createHash, sign as cryptoSign } from 'node:crypto';
import {
  loadOrCreateDeviceKeys,
  buildAndSign,
  loadCachedDeviceToken,
  saveCachedDeviceToken,
} from '../gateway-client.js';
import type { SignParams, DeviceIdentity } from '../gateway-client.js';

// ── Helpers ────────────────────────────────────────────────────────────

/** Reconstruct the v3 payload string that buildAndSign() signs. */
function reconstructPayload(params: Omit<SignParams, 'privateKeyPem'>): string {
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token,
    params.nonce,
    params.platform,
    '', // deviceFamily (empty)
  ].join('|');
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('loadOrCreateDeviceKeys', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'device-auth-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates new Ed25519 keypair when .device-identity.json does not exist', () => {
    const identity = loadOrCreateDeviceKeys(tmpDir);
    expect(identity.deviceId).toBeTruthy();
    expect(identity.publicKey).toBeTruthy();
    expect(identity.privateKey).toBeTruthy();
  });

  it('writes identity file with mode 0600', () => {
    loadOrCreateDeviceKeys(tmpDir);
    const stat = statSync(join(tmpDir, '.device-identity.json'));
    // 0o600 = owner read/write only (decimal 384)
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('generates deviceId as SHA-256 of raw Ed25519 public key bytes', () => {
    const identity = loadOrCreateDeviceKeys(tmpDir);
    // Verify by recomputing: extract raw 32-byte key from SPKI PEM
    const derBase64 = identity.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    const rawKey = Buffer.from(derBase64, 'base64').subarray(-32);
    const expectedId = createHash('sha256').update(rawKey).digest('hex');
    expect(identity.deviceId).toBe(expectedId);
    expect(identity.deviceId).toHaveLength(64); // SHA-256 hex
  });

  it('reloads existing identity from file on second call (idempotent)', () => {
    const first = loadOrCreateDeviceKeys(tmpDir);
    const second = loadOrCreateDeviceKeys(tmpDir);
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKey).toBe(first.privateKey);
  });

  it('generates fresh keys if existing file contains invalid JSON', () => {
    writeFileSync(join(tmpDir, '.device-identity.json'), 'not-json!!!');
    const identity = loadOrCreateDeviceKeys(tmpDir);
    // Should create new keys (not throw)
    expect(identity.deviceId).toBeTruthy();
    expect(identity.publicKey).toContain('BEGIN PUBLIC KEY');
  });

  it('public key is valid PEM format', () => {
    const identity = loadOrCreateDeviceKeys(tmpDir);
    expect(identity.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
    expect(identity.publicKey).toMatch(/\n-----END PUBLIC KEY-----\n?$/);
  });

  it('private key is valid PEM format', () => {
    const identity = loadOrCreateDeviceKeys(tmpDir);
    expect(identity.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(identity.privateKey).toMatch(/\n-----END PRIVATE KEY-----\n?$/);
  });

  it('generated keys can sign and verify data', () => {
    const identity = loadOrCreateDeviceKeys(tmpDir);
    const data = Buffer.from('test-data');
    const signature = cryptoSign(null, data, identity.privateKey);
    const valid = verify(null, data, identity.publicKey, signature);
    expect(valid).toBe(true);
  });
});

describe('buildAndSign', () => {
  let identity: DeviceIdentity;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'device-auth-sign-'));
    identity = loadOrCreateDeviceKeys(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSignParams(overrides: Partial<SignParams> = {}): SignParams {
    return {
      privateKeyPem: identity.privateKey,
      deviceId: identity.deviceId,
      clientId: 'gateway-client',
      clientMode: 'backend',
      role: 'operator',
      scopes: ['operator.admin', 'operator.write'],
      signedAtMs: 1711234567890,
      token: 'test-token-abc',
      nonce: 'nonce-123',
      platform: 'linux',
      ...overrides,
    };
  }

  it('returns a base64url-encoded string (no +, /, or =)', () => {
    const sig = buildAndSign(makeSignParams());
    expect(sig).toBeTruthy();
    expect(sig).not.toMatch(/[+/=]/);
    // base64url charset: [A-Za-z0-9_-]
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('signature verifies against the v3 payload using the public key', () => {
    const params = makeSignParams();
    const sig = buildAndSign(params);
    const payload = reconstructPayload(params);
    const sigBuffer = Buffer.from(sig, 'base64url');
    const valid = verify(null, Buffer.from(payload), identity.publicKey, sigBuffer);
    expect(valid).toBe(true);
  });

  it('v3 payload format includes all expected pipe-delimited fields', () => {
    const params = makeSignParams({
      deviceId: 'dev-123',
      clientId: 'my-client',
      clientMode: 'backend',
      role: 'operator',
      scopes: ['scope.a', 'scope.b'],
      signedAtMs: 9999,
      token: 'tok',
      nonce: 'n1',
      platform: 'linux',
    });
    const expected = 'v3|dev-123|my-client|backend|operator|scope.a,scope.b|9999|tok|n1|linux|';
    // We can't read the payload from the signature, but we verify it matches
    // by checking the signature validates against the expected payload
    const sig = buildAndSign(params);
    const sigBuffer = Buffer.from(sig, 'base64url');
    const valid = verify(null, Buffer.from(expected), identity.publicKey, sigBuffer);
    expect(valid).toBe(true);
  });

  it('multiple scopes are comma-joined in payload', () => {
    const params = makeSignParams({ scopes: ['a', 'b', 'c'] });
    const sig = buildAndSign(params);
    const payload = reconstructPayload(params);
    expect(payload).toContain('|a,b,c|');
    const valid = verify(null, Buffer.from(payload), identity.publicKey, Buffer.from(sig, 'base64url'));
    expect(valid).toBe(true);
  });

  it('empty deviceFamily field is preserved as trailing pipe', () => {
    const params = makeSignParams();
    const payload = reconstructPayload(params);
    // Should end with | (empty deviceFamily) after platform
    expect(payload).toMatch(/\|linux\|$/);
  });

  it('different nonces produce different signatures', () => {
    const sig1 = buildAndSign(makeSignParams({ nonce: 'nonce-aaa' }));
    const sig2 = buildAndSign(makeSignParams({ nonce: 'nonce-bbb' }));
    expect(sig1).not.toBe(sig2);
  });
});

describe('loadCachedDeviceToken / saveCachedDeviceToken', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'device-token-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('roundtrip: save then load returns same token, role, scopes', () => {
    const data = { token: 'dt_abc123', role: 'operator', scopes: ['operator.write'] };
    saveCachedDeviceToken(tmpDir, data);
    const loaded = loadCachedDeviceToken(tmpDir);
    expect(loaded).toEqual(data);
  });

  it('writes file with mode 0600', () => {
    saveCachedDeviceToken(tmpDir, { token: 'test' });
    const stat = statSync(join(tmpDir, '.device-token.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('returns null when file does not exist', () => {
    const result = loadCachedDeviceToken(tmpDir);
    expect(result).toBeNull();
  });

  it('returns null when file contains invalid JSON', () => {
    writeFileSync(join(tmpDir, '.device-token.json'), '{{bad json');
    const result = loadCachedDeviceToken(tmpDir);
    expect(result).toBeNull();
  });

  it('overwrites existing token file on save', () => {
    saveCachedDeviceToken(tmpDir, { token: 'old-token' });
    saveCachedDeviceToken(tmpDir, { token: 'new-token', role: 'admin' });
    const loaded = loadCachedDeviceToken(tmpDir);
    expect(loaded?.token).toBe('new-token');
    expect(loaded?.role).toBe('admin');
  });
});
