import { useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Brain, Loader2, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { AIMessage } from '@/hooks/useAIConversations';

interface ChatMessagesProps {
  messages: AIMessage[];
  isLoading: boolean;
  userInitial: string;
  onSuggestionClick: (suggestion: string) => void;
}

const suggestions = [
  'Who performed best last quarter?',
  'Predict costs for a music video',
  'Which clients need attention?',
];

export function ChatMessages({
  messages,
  isLoading,
  userInitial,
  onSuggestionClick,
}: ChatMessagesProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-8">
        <Brain className="h-16 w-16 text-muted-foreground/30 mb-4" />
        <h3 className="text-lg font-semibold mb-2">Start a Conversation</h3>
        <p className="text-muted-foreground max-w-sm">
          Ask me anything about your projects, clients, or team. I have access to all your historical data.
        </p>
        <div className="flex flex-wrap gap-2 mt-4 justify-center">
          {suggestions.map((suggestion) => (
            <Button
              key={suggestion}
              variant="outline"
              size="sm"
              onClick={() => onSuggestionClick(suggestion)}
              className="text-xs"
            >
              {suggestion}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto space-y-4 p-4">
      {messages.map((message) => (
        <div
          key={message.id}
          className={cn(
            'flex gap-3',
            message.role === 'user' ? 'justify-end' : 'justify-start'
          )}
        >
          {message.role === 'assistant' && (
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Brain className="h-4 w-4 text-primary" />
            </div>
          )}
          <div
            className={cn(
              'max-w-[80%] rounded-lg p-4',
              message.role === 'user'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted'
            )}
          >
            {message.role === 'assistant' ? (
              <div className="prose prose-sm max-w-none dark:prose-invert">
                <ReactMarkdown>{message.content}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm">{message.content}</p>
            )}
            {message.thought_trace && (
              <div className="mt-2 pt-2 border-t border-border/50 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <HelpCircle className="h-3 w-3" />
                  {message.thought_trace.type} • {Math.round(message.thought_trace.contextSize / 1000)}k context
                </span>
              </div>
            )}
          </div>
          {message.role === 'user' && (
            <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-medium">{userInitial}</span>
            </div>
          )}
        </div>
      ))}
      
      {isLoading && (
        <div className="flex gap-3">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
            <Loader2 className="h-4 w-4 text-primary animate-spin" />
          </div>
          <div className="bg-muted rounded-lg p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Analyzing studio data</span>
              <Loader2 className="h-3 w-3 animate-spin" />
            </div>
          </div>
        </div>
      )}
      
      <div ref={messagesEndRef} />
    </div>
  );
}
