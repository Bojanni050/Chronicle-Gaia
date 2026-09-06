
import { describe, it, expect } from 'vitest';
import { parseChatMessages } from './chatUtils';

describe('chatUtils: parseChatMessages', () => {
  it('correctly parses a standard multi-turn conversation', () => {
    const text = `User: Hello AI\n\nAssistant: Hello User! How can I help?\n\nUser: Tell me a joke.`;
    const messages = parseChatMessages(text, Date.now());
    
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('user');
    expect(messages[0].text).toBe('Hello AI');
    expect(messages[1].role).toBe('model');
    expect(messages[1].name).toBe('Assistant');
    expect(messages[2].role).toBe('user');
  });

  it('handles variations in headers (ChatGPT, Claude, Qwen)', () => {
    const text = `ChatGPT: I am an OpenAI model.\n\nClaude: I am an Anthropic model.\n\nQwen: I am an Alibaba model.`;
    const messages = parseChatMessages(text, Date.now());
    
    expect(messages).toHaveLength(3);
    expect(messages[0].name).toBe('ChatGPT');
    expect(messages[1].name).toBe('Claude');
    expect(messages[2].name).toBe('Qwen');
    expect(messages.every(m => m.role === 'model')).toBe(true);
  });

  it('correctly associates "You" as the user', () => {
    const text = `You: Where is the nearest star?\n\nAssistant: Proxima Centauri.`;
    const messages = parseChatMessages(text, Date.now());
    
    expect(messages[0].role).toBe('user');
    expect(messages[0].name).toBe('User');
  });

  it('handles markdown content within messages', () => {
    const text = `User: Check this code.\n\nAssistant: \`\`\`js\nconsole.log("test");\n\`\`\``;
    const messages = parseChatMessages(text, Date.now());
    
    expect(messages[1].text).toContain('```js');
  });
});
