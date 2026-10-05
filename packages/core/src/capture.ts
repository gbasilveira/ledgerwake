import type { LwEvent } from './envelope.js';
import { sha256Hex } from './hash.js';

/** Full content kept at the edge and referenced from an event by `content.ref` (SPEC §5, §9.1). */
export interface ContentBlob {
  ref: string;
  body: string;
}

/**
 * An event ready for the store. `naturalKey` names the observation independently of the channel
 * that saw it (for example `tool.call:<session>:<tool_use_id>`), so the same observation arriving
 * from a hook and from a transcript is stored once; null means the event is never deduplicated.
 */
export interface CapturedEvent {
  event: LwEvent;
  naturalKey: string | null;
  contents: ContentBlob[];
}

/** Content-addressed reference for a piece of full content. */
export function contentBlob(value: unknown): ContentBlob {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return { ref: `sha256:${sha256Hex(body)}`, body };
}
