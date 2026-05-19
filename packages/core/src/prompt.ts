import { ChatMessage } from './types.js';

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (item && typeof item === 'object') {
        const maybeType = (item as Record<string, unknown>).type;
        const maybeText = (item as Record<string, unknown>).text;
        if (maybeType === 'text' && typeof maybeText === 'string') {
          parts.push(maybeText);
        }
      }
    }
    return parts.join('\n').trim();
  }

  if (content && typeof content === 'object') {
    const text = (content as Record<string, unknown>).text;
    if (typeof text === 'string') {
      return text;
    }
  }

  return String(content ?? '');
}

export function compilePromptFromMessages(messages: ChatMessage[]): string {
  const blocks = messages.map((message) => {
    const role = message.role.toUpperCase();
    const text = normalizeContent(message.content).trim();
    return `${role}:\n${text}`;
  });

  return blocks.join('\n\n').trim();
}

export function parseResponsesInputToMessages(input: unknown): ChatMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }

  if (!Array.isArray(input)) {
    return [{ role: 'user', content: String(input ?? '') }];
  }

  const messages: ChatMessage[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const roleRaw = (item as Record<string, unknown>).role;
    const role =
      roleRaw === 'assistant' || roleRaw === 'system' || roleRaw === 'tool'
        ? roleRaw
        : 'user';

    const content = (item as Record<string, unknown>).content;
    messages.push({ role, content });
  }

  if (messages.length === 0) {
    messages.push({ role: 'user', content: '' });
  }

  return messages;
}
