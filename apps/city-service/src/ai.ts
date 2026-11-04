// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { CapabilitiesError, type CapabilitiesClient } from '@synapsedx/capabilities';
import { CapabilityUnavailableError, FILES_DEPENDENCY } from './files';

/**
 * AI capability adapter.
 *
 * The Tier-2 capabilities SDK now exposes `ai.status`/`ai.chat` (backed by the
 * Tier-1 inference service), so City proxies real model output and never
 * answers with a canned sentence. When the deployment's Tier-2 release does not
 * expose the contract, or the inference provider is down, the endpoint returns
 * a typed 503 naming the missing dependency.
 */

export const AI_DEPENDENCY = 'https://github.com/vku-open-source-2026/SynapseDX/issues/11';

export type AiCapabilityStatus =
  | {
      status: 'ready' | 'degraded';
      service: 'synapsecity-ai';
      provider: 'synapsedx';
      configured: true;
      upstream: Record<string, unknown>;
      dependency?: string;
    }
  | {
      status: 'unavailable';
      service: 'synapsecity-ai';
      provider: 'synapsedx';
      configured: false;
      dependency: string;
      detail: string;
    };

export interface AiChatResult {
  message: string;
  citations: unknown[];
  provider: 'synapsedx';
  model?: string;
  upstream: unknown;
}

function unavailableDetail(error: unknown): string {
  if (error instanceof CapabilitiesError) {
    const code = error.code || error.status || 'error';
    return `Tier-2 AI capability is unavailable (${String(code)}).`;
  }
  return 'Tier-2 AI capability is unreachable.';
}

function upstreamPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

export async function aiStatus(client: CapabilitiesClient): Promise<AiCapabilityStatus> {
  try {
    const upstream = upstreamPayload(await client.ai.status());
    const status = String(upstream.status || '').toLowerCase();
    return {
      status: status === 'ok' ? 'ready' : 'degraded',
      service: 'synapsecity-ai',
      provider: 'synapsedx',
      configured: true,
      upstream,
      ...(status === 'ok' ? {} : { dependency: AI_DEPENDENCY }),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      service: 'synapsecity-ai',
      provider: 'synapsedx',
      configured: false,
      dependency: AI_DEPENDENCY,
      detail: unavailableDetail(error),
    };
  }
}

function extractMessage(payload: unknown): { message: string; model?: string } {
  if (typeof payload === 'string') return { message: payload };
  if (!payload || typeof payload !== 'object') return { message: '' };
  const record = payload as Record<string, unknown>;
  const choice = Array.isArray(record.choices) ? record.choices[0] : null;
  const choiceRecord = choice && typeof choice === 'object' ? choice as Record<string, unknown> : null;
  const messageRecord = choiceRecord?.message && typeof choiceRecord.message === 'object'
    ? choiceRecord.message as Record<string, unknown>
    : null;
  const content = messageRecord?.content ?? record.message ?? record.content ?? record.response;
  if (typeof content === 'string') {
    return {
      message: content,
      ...(record.model ? { model: String(record.model) } : {}),
    };
  }
  return { message: '' };
}

export async function aiChat(client: CapabilitiesClient, message: string, context?: Record<string, unknown>): Promise<AiChatResult> {
  const system = [
    'You are the SynapseCity infrastructure operations assistant.',
    'Answer using only the supplied City context. If the data is insufficient, say so.',
  ].join(' ');
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system', content: system },
    ...(context && Object.keys(context).length > 0
      ? [{ role: 'user' as const, content: `City context: ${JSON.stringify(context)}` }]
      : []),
    { role: 'user', content: message },
  ];
  try {
    const upstream = await client.ai.chat(messages);
    const { message: answer, model } = extractMessage(upstream);
    if (!answer) {
      throw new CapabilityUnavailableError('ai_empty_response', AI_DEPENDENCY);
    }
    return {
      message: answer,
      citations: [],
      provider: 'synapsedx',
      ...(model ? { model } : {}),
      upstream,
    };
  } catch (error) {
    if (error instanceof CapabilityUnavailableError) throw error;
    throw new CapabilityUnavailableError('ai_capability_unavailable', AI_DEPENDENCY);
  }
}

export { FILES_DEPENDENCY };
