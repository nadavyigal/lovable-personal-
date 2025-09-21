import React, { useState } from 'react';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export default function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);

  const send = async () => {
    if (!input.trim()) return;
    const next = [...messages, { role: 'user', content: input } as ChatMessage];
    setMessages(next);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch('http://localhost:8787/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      });
      let assistantContent = 'No response';
      try {
        const data = await res.json();
        assistantContent = typeof data?.message?.content === 'string' ? data.message.content : JSON.stringify(data);
      } catch (_) {
        assistantContent = 'Invalid JSON response';
      }
      setMessages((m) => [...m, { role: 'assistant', content: assistantContent }]);
    } catch (e: any) {
      setMessages((m) => [...m, { role: 'assistant', content: 'Error: ' + (e?.message || 'request failed') }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen grid grid-cols-2">
      <div className="h-full flex flex-col border-r">
        <div className="flex-1 overflow-auto p-4 space-y-2">
          {messages.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
              <div className={
                'inline-block px-3 py-2 rounded ' +
                (m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-100')
              }>
                {m.content}
              </div>
            </div>
          ))}
        </div>
        <div className="p-3 border-t flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="Type a message"
            className="flex-1 border rounded px-3 py-2"
          />
          <button onClick={send} disabled={loading} className="px-4 py-2 rounded bg-black text-white">
            {loading ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
      <div className="h-full">
        <iframe title="workspace" src="http://localhost:5173" className="w-full h-full"></iframe>
      </div>
    </div>
  );
}

