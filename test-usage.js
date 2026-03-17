const fs = require('fs');
const path = require('path');
const dir = path.join(require('os').homedir(), '.openclaw/agents/main/sessions');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') || f.includes('.jsonl.reset.'));
console.log('Files:', files.length);
let records = 0;
for (const file of files) {
  const content = fs.readFileSync(path.join(dir, file), 'utf8');
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'message' && entry.message?.role === 'assistant' && entry.message?.usage) {
        const u = entry.message.usage;
        if (u.totalTokens || u.input || u.output) {
          records++;
          if (records <= 3) console.log(JSON.stringify({model: entry.message.model, date: (entry.timestamp||'').slice(0,10), tokensIn: (u.input||0)+(u.cacheRead||0)+(u.cacheWrite||0), tokensOut: u.output||0}));
        }
      }
    } catch {}
  }
}
console.log('Total records:', records);
