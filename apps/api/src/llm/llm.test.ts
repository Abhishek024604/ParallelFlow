import { EventEmitter } from 'node:events';
import type { Logger } from '@saras/observability';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { allowedModels, DEFAULT_MODEL, modelPlan, tierOf, upstreamBody } from './models.js';
import { LlmProxy } from './proxy.js';

const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;
const MODELS = ['vendor/primary', 'vendor/fallback-a', 'vendor/fallback-b'];

describe('model allowlist', () => {
  it('reads RUNTIME_MODEL then fallbacks, like the runtime', () => {
    expect(allowedModels({})[0]).toBe(DEFAULT_MODEL);
    expect(allowedModels({ RUNTIME_MODEL: 'a/b', RUNTIME_FALLBACK_MODELS: 'c/d, a/b' })).toEqual([
      'a/b',
      'c/d',
    ]);
    expect(allowedModels({ RUNTIME_MODEL: 'a/b', RUNTIME_FALLBACK_MODELS: '' })).toEqual(['a/b']);
  });

  it('labels each model with the runtime tier it belongs to', () => {
    const env = {
      RUNTIME_MODEL_FAST: 'v/fast',
      RUNTIME_MODEL_STRONG: 'v/strong',
      RUNTIME_FALLBACK_MODELS: 'v/spare, v/fast',
    };
    expect(allowedModels(env)).toEqual(['v/strong', 'v/fast', 'v/spare']);
    expect(tierOf(env)).toEqual({ 'v/strong': 'strong', 'v/fast': 'fast', 'v/spare': 'fallback' });
    expect(tierOf({ RUNTIME_MODEL: 'v/one', RUNTIME_FALLBACK_MODELS: '' })).toEqual({
      'v/one': 'strong',
    });
  });

  it('plans the fallback chain for the primary only, and refuses other models', () => {
    expect(modelPlan(undefined, MODELS)).toEqual(MODELS);
    expect(modelPlan('vendor/primary', MODELS)).toEqual(MODELS);
    expect(modelPlan('vendor/fallback-b', MODELS)).toEqual(['vendor/fallback-b']);
    expect(modelPlan('openai/gpt-5', MODELS)).toBeNull();
    expect(modelPlan(42, MODELS)).toBeNull();
    expect(modelPlan(undefined, [])).toBeNull();
  });

  it('forwards only OpenAI fields, never OpenRouter routing fields', () => {
    const shaped = upstreamBody(
      { messages: [{ role: 'user', content: 'x' }], stream: true, models: ['x/y'], provider: {} },
      'vendor/primary',
    );
    expect(shaped).toEqual({
      ok: true,
      body: { model: 'vendor/primary', messages: [{ role: 'user', content: 'x' }], stream: true },
    });
    expect(upstreamBody({ messages: [] }, 'm').ok).toBe(false);
    expect(upstreamBody([], 'm').ok).toBe(false);
  });
});

function fakeRes() {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    sent: '' as string,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    json(body: unknown) {
      res.sent = JSON.stringify(body);
      res.writableEnded = true;
      return res;
    },
    end() {
      res.writableEnded = true;
    },
    write(chunk: Buffer) {
      res.sent += chunk.toString();
      return true;
    },
    once: EventEmitter.prototype.once,
  });
  return res;
}

describe('LLM proxy', () => {
  it('tries the next model when the primary is rate limited, and relays the answer', async () => {
    const asked: string[] = [];
    const fetch = (async (_url: string, init: { body: string }) => {
      const { model } = JSON.parse(init.body) as { model: string };
      asked.push(model);
      if (model === 'vendor/primary') return new Response('busy', { status: 429 });
      return new Response(JSON.stringify({ id: 'x', model }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;
    const proxy = new LlmProxy({ apiKey: 'k', models: MODELS, logger, fetch });
    expect(proxy.check({ model: 'nope/x', messages: [{}] })?.status).toBe(400);
    expect(proxy.check({ messages: [{ role: 'user', content: 'hi' }] })).toBeNull();

    const res = fakeRes();
    // A minimal writable for Readable#pipe.
    const piped = Object.assign(res, {
      on: res.on.bind(res),
      emit: res.emit.bind(res),
      end: () => {
        res.writableEnded = true;
        res.emit('finish');
        res.emit('close');
      },
    });
    await proxy.forward(
      { messages: [{ role: 'user', content: 'hi' }] },
      piped as unknown as Response,
    );
    expect(asked).toEqual(['vendor/primary', 'vendor/fallback-a']);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.sent)).toEqual({ id: 'x', model: 'vendor/fallback-a' });
  });

  it('answers 503 when no key is configured', () => {
    const proxy = new LlmProxy({ models: MODELS, logger });
    expect(proxy.check({ messages: [{}] })?.status).toBe(503);
  });
});
