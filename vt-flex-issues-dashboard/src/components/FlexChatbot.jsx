import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const QUICK_TOPICS = [
  { icon: '🔇', label: 'No Audio',           prompt: 'I am troubleshooting a No Audio issue in Flex. Walk me through the most common causes and fixes.' },
  { icon: '📞', label: 'Call Dropped',       prompt: 'A call dropped unexpectedly in Flex. Help me diagnose what likely happened and how to recover.' },
  { icon: '💰', label: 'Quote Greyed Out',   prompt: 'A quote button is greyed out for one of my agents. What permissions, plan states, or workflow checks should I verify?' }
];

export default function FlexChatbot({ session, prefillText, onPrefillConsumed }) {
  const [messages, setMessages] = useState([]); // [{ role: 'user'|'assistant', content: string }]
  const [input, setInput]       = useState('');
  const [sending, setSending]   = useState(false);
  const [error, setError]       = useState(null);
  const scrollRef     = useRef(null);
  const composerRef   = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sending]);

  // Consume a prefill (e.g. from "Copy for Help Bot" in the issue drawer):
  // drop it into the composer, scroll/focus it, then clear so it doesn't
  // re-fire if the user edits or sends.
  useEffect(() => {
    if (prefillText) {
      setInput(prefillText);
      onPrefillConsumed?.();
      // Focus + move cursor to end so manager can hit Enter immediately
      // or add a clarifying note before sending.
      setTimeout(() => {
        if (composerRef.current) {
          composerRef.current.focus();
          composerRef.current.setSelectionRange(prefillText.length, prefillText.length);
        }
      }, 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillText]);

  function newChat() {
    setMessages([]);
    setInput('');
    setError(null);
  }

  async function send(text) {
    const content = text.trim();
    if (!content || sending) return;

    const nextMessages = [...messages, { role: 'user', content }];
    setMessages(nextMessages);
    setInput('');
    setSending(true);
    setError(null);

    try {
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in');

      const res = await fetch('/.netlify/functions/chat', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ messages: nextMessages })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.error || `Request failed (${res.status})`;
        throw new Error(msg);
      }
      const text = (data.text || '').trim();
      if (!text) throw new Error('No response from assistant');

      setMessages([...nextMessages, { role: 'assistant', content: text }]);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSending(false);
    }
  }

  function onComposerKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <div className="max-w-[1100px] mx-auto px-6 lg:px-10 pb-20">
      <div className="card mt-6 flex flex-col" style={{ height: 'calc(100vh - 220px)', minHeight: 540 }}>
        {/* Header — dark band */}
        <div className="flex items-center justify-between px-5 py-4 bg-[#1a1a2e] text-paper">
          <div>
            <div className="font-display text-2xl leading-none">
              Flex Troubleshooting <em className="not-italic text-rust">bot</em>
            </div>
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-paper/55 mt-1">
              ai assistant · web-aware
            </div>
          </div>
          <button
            type="button"
            onClick={newChat}
            className="font-mono text-[11px] uppercase tracking-wider px-3 py-1.5 border border-paper/40 hover:bg-paper hover:text-ink transition-colors"
          >
            ↻ New Chat
          </button>
        </div>

        {/* Messages or empty state */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto bg-bone/30">
          {messages.length === 0 ? (
            <EmptyState onPick={(p) => send(p)} />
          ) : (
            <div className="p-5 space-y-4">
              {messages.map((m, i) => (
                <Bubble key={i} role={m.role}>{m.content}</Bubble>
              ))}
              {sending && (
                <div className="font-mono text-xs text-ink/55 px-1">thinking…</div>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="border-t border-ember/40 bg-ember/10 px-5 py-3 font-mono text-xs text-ember">
            {error}
          </div>
        )}

        {/* Composer */}
        <div className="border-t border-ink/15 p-4 bg-paper">
          <div className="flex gap-3 items-stretch">
            <textarea
              ref={composerRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Describe the Flex issue you're seeing…  (Enter to send · Shift+Enter for newline)"
              rows={2}
              disabled={sending}
              className="field font-sans resize-none flex-1 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => send(input)}
              disabled={sending || !input.trim()}
              className="btn px-5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink/40 mt-2">
            30 messages per hour · responses may be inaccurate, verify before acting
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onPick }) {
  return (
    <div className="h-full flex flex-col items-center justify-center px-8 text-center">
      <div className="font-display text-3xl mb-2">How can I help?</div>
      <p className="font-sans text-sm text-ink/60 max-w-md mb-8">
        Ask anything about Flex issues, configurations, or workflows. Or jump in with a common topic:
      </p>
      <div className="flex flex-wrap gap-3 justify-center">
        {QUICK_TOPICS.map((t) => (
          <button
            key={t.label}
            type="button"
            onClick={() => onPick(t.prompt)}
            className="card px-4 py-3 hover:bg-paper hover:shadow-sharp transition-shadow text-left"
          >
            <div className="font-display text-lg leading-none">
              <span className="mr-2">{t.icon}</span>
              {t.label}
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-ink/45 mt-1.5">
              quick start
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function Bubble({ role, children }) {
  const isUser = role === 'user';
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          'max-w-[80%] px-4 py-3 border ' +
          (isUser
            ? 'bg-[#1a1a2e] text-paper border-[#1a1a2e]'
            : 'bg-paper text-ink border-ink/15')
        }
      >
        {isUser ? (
          <div className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{children}</div>
        ) : (
          <div className="prose-chat font-sans text-sm leading-relaxed">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={mdComponents}
            >
              {children}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

// Minimal element overrides so markdown matches the editorial aesthetic
// without pulling in a full prose plugin.
const mdComponents = {
  a: (props) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-rust underline underline-offset-2 hover:text-ember"
    />
  ),
  code: ({ inline, className, children, ...props }) =>
    inline ? (
      <code className="font-mono text-[12px] bg-bone/70 px-1 py-0.5 border border-ink/10" {...props}>
        {children}
      </code>
    ) : (
      <pre className="font-mono text-[12px] bg-bone/50 border border-ink/15 p-3 overflow-x-auto my-2">
        <code {...props}>{children}</code>
      </pre>
    ),
  ul: (p) => <ul className="list-disc pl-5 my-2 space-y-1" {...p} />,
  ol: (p) => <ol className="list-decimal pl-5 my-2 space-y-1" {...p} />,
  p:  (p) => <p className="my-2 first:mt-0 last:mb-0" {...p} />,
  strong: (p) => <strong className="font-semibold" {...p} />,
  em: (p) => <em className="italic" {...p} />,
  h1: (p) => <h2 className="font-display text-xl mt-3 mb-1" {...p} />,
  h2: (p) => <h3 className="font-display text-lg mt-3 mb-1" {...p} />,
  h3: (p) => <h4 className="font-display text-base mt-3 mb-1" {...p} />,
  blockquote: (p) => <blockquote className="border-l-2 border-ink/25 pl-3 my-2 text-ink/70" {...p} />
};
