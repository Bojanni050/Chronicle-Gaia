
export interface Message {
  role: 'user' | 'model' | 'system';
  name: string;
  text: string;
  timestamp: number;
}

export const parseChatMessages = (fullText: string, baseTime: number): Message[] => {
  const lines = fullText.replace(/\r\n/g, '\n').split('\n');
  const messages: Message[] = [];
  let simulatedTime = baseTime;
  
  let currentRole: 'user' | 'model' | 'system' = 'user';
  let currentName = 'User';
  let currentBuffer: string[] = [];
  
  // Improved Regex to handle various export formats:
  // Matches: "User:", "Assistant:", "ChatGPT:", "**User**:", "## User", "You:", "Human:", "Qwen:", etc.
  const regex = /^[\W_]*(User|You|Assistant|ChatGPT|Claude|Gemini|System|Model|Human|AI|Bot|Qwen)[\W_]*(?::|$)(\s*.*)/i;

  lines.forEach(line => {
    const match = line.match(regex);
    
    if (match) {
      const isExplicitHeader = match[0].includes(':');
      const isShortHeader = line.trim().length < 50;
      
      if (isExplicitHeader || isShortHeader) {
          if (currentBuffer.length > 0) {
            messages.push({ 
                role: currentRole, 
                name: currentName, 
                text: currentBuffer.join('\n').trim(), 
                timestamp: simulatedTime 
            });
            simulatedTime += 1000 * 60 * 2;
          }
          
          const roleKey = match[1];
          const content = match[2] || '';
          
          currentName = roleKey.replace(/[\*_#]/g, '').trim();
          if (currentName.toLowerCase() === 'you') currentName = 'User';
          
          if (['User', 'You', 'Human'].some(n => roleKey.match(new RegExp(n, 'i')))) {
              currentRole = 'user';
          } else if (['System'].some(n => roleKey.match(new RegExp(n, 'i')))) {
              currentRole = 'system';
          } else {
              currentRole = 'model';
          }
          
          currentBuffer = [content];
          return;
      }
    }
    
    currentBuffer.push(line);
  });

  if (currentBuffer.length > 0) {
      messages.push({ 
          role: currentRole, 
          name: currentName, 
          text: currentBuffer.join('\n').trim(), 
          timestamp: simulatedTime 
      });
  }
  
  return messages;
};

export const convertJsonToTranscript = (json: any): string => {
  let messages: any[] = [];
  
  if (Array.isArray(json)) {
    messages = json;
  } else if (json && typeof json === 'object') {
     if (json.messages && Array.isArray(json.messages)) messages = json.messages;
     else if (json.history && Array.isArray(json.history)) messages = json.history;
     else if (json.conversation && Array.isArray(json.conversation)) messages = json.conversation;
  }

  if (messages.length === 0) return '';

  return messages.map(msg => {
    const role = msg.role || msg.from || (msg.type === 'human' ? 'user' : 'model');
    const content = msg.content || msg.value || msg.text || '';
    
    let displayName = 'User';
    const lowerRole = String(role).toLowerCase();
    
    if (['user', 'human'].includes(lowerRole)) {
        displayName = 'User';
    } else if (['assistant', 'model', 'bot', 'qwen', 'gpt', 'system'].includes(lowerRole)) {
        // Use standard names that our regex catches easily, or specific ones if needed
        if (lowerRole === 'system') displayName = 'System';
        else displayName = 'Assistant'; 
    } else {
        displayName = role ? (String(role).charAt(0).toUpperCase() + String(role).slice(1)) : 'Assistant';
    }

    return `${displayName}: ${content}`;
  }).join('\n\n');
};
