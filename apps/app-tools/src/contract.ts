import { readFileSync } from 'node:fs';

// The App Tools contract (docs/contracts/app-tools_v0.2.mcp.json): tool names, input schemas and the
// x-saras policy of each tool. Loaded once at startup; the contract file is the source of truth.

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: string[];
  format?: string;
  maxLength?: number;
  maximum?: number;
}

export interface ToolPolicy {
  required_capability: string;
  allowed_agents: string[];
  side_effect: 'read' | 'write' | 'write-confirm';
  scope: string;
  autonomy_class: string | null;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  'x-saras': ToolPolicy;
}

export interface AppToolsContract {
  server: { name: string; version: string };
  human_only_actions_not_exposed: string[];
  tools: ToolSpec[];
}

export const CONTRACT_URL = new URL(
  '../../../docs/contracts/app-tools_v0.2.mcp.json',
  import.meta.url,
);

export function loadContract(url: URL = CONTRACT_URL): AppToolsContract {
  return JSON.parse(readFileSync(url, 'utf8')) as AppToolsContract;
}

/** Minimal JSON Schema check for tool arguments (the contract uses only these keywords). */
export function validateArgs(schema: JsonSchema, value: unknown, path = 'args'): string | null {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `${path} must be an object`;
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (record[key] === undefined) return `${path}.${key} is required`;
      }
      for (const [key, child] of Object.entries(record)) {
        const sub = schema.properties?.[key];
        if (!sub) {
          if (schema.additionalProperties === false) return `${path}.${key} is not allowed`;
          continue;
        }
        if (child === undefined) continue;
        const error = validateArgs(sub, child, `${path}.${key}`);
        if (error) return error;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`;
      for (let i = 0; i < value.length; i++) {
        const error = schema.items ? validateArgs(schema.items, value[i], `${path}[${i}]`) : null;
        if (error) return error;
      }
      return null;
    }
    case 'string': {
      if (typeof value !== 'string') return `${path} must be a string`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${path} is too long`;
      }
      if (schema.enum && !schema.enum.includes(value)) return `${path} is not an allowed value`;
      if (schema.format === 'uuid' && !UUID.test(value)) return `${path} must be a uuid`;
      if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
        return `${path} must be a date-time`;
      }
      return null;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return `${path} must be an integer`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) return `${path} is too large`;
      return null;
    }
    default:
      return null;
  }
}
