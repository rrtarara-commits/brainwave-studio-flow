import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import ReactMarkdown from 'react-markdown';
import {
  Brain,
  Send,
  Loader2,
  Users,
  DollarSign,
  AlertTriangle,
  MessageSquare,
  Sparkles,
  HelpCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  thoughtTrace?: {
    type: string;
    contextSize: number;
    model: string;
  };
}

interface QuickAction {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  type: 'crew_recommendation' | 'budget_prediction' | 'sentiment_analysis' | 'chat';
  prompt: string;
}

const quickActions: QuickAction[] = [
  {
    id: 'crew',
    title: 'Crew Recommendations',
    description: 'Find the best editor for your next project',
    icon: Users,
    type: 'crew_recommendation',
    prompt: 'Based on our historical data, who would be the best editor for a new commercial project? Consider turnaround time, quality ratings, and availability.',
  },
  {
    id: 'budget',
    title: 'Budget Prediction',
    description: 'Estimate costs based on similar projects',
    icon: DollarSign,
    type: 'budget_prediction',
    prompt: 'I need a cost estimate for a new corporate video project. What should we budget based on our historical project data?',
  },
  {
    id: 'sentiment',
    title: 'Client Insights',
    description: 'Analyze client patterns and risks',
    icon: AlertTriangle,
    type: 'sentiment_analysis',
    prompt: 'Analyze our current project portfolio. Are there any clients or projects showing concerning patterns that we should address proactively?',
  },
  {
    id: 'help',
    title: 'Ask Anything',
    description: 'Query project history and knowledge',
    icon: HelpCircle,
    type: 'chat',
    prompt: '',
  },
];

export default function AIBrain() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('chat');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async (content: string, type: 'chat' | 'crew_recommendation' | 'budget_prediction' | 'sentiment_analysis' = 'chat') => {
    if (!content.trim()) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);

    try {
      const { data, error } = await supabase.functions.invoke('ai-brain', {
        body: {
          type,
          messages: [...messages, userMessage].map(m => ({
            role: m.role,
            content: m.content,
          })),
        },
      });

      if (error) throw error;

      if (data?.success) {
        const assistantMessage: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data.response,
          timestamp: new Date(),
          thoughtTrace: data.thoughtTrace,
        };
        setMessages(prev => [...prev, assistantMessage]);
      } else {
        throw new Error(data?.error || 'Failed to get response');
      }
    } catch (error) {
      console.error('AI Brain error:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to communicate with AI Brain',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuickAction = (action: QuickAction) => {
    if (action.prompt) {
      sendMessage(action.prompt, action.type);
    }
    setActiveTab('chat');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(inputValue);
  };

  return (
    <AppLayout>
      <div className="flex flex-col h-[calc(100vh-4rem)] animate-in">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center">
              <Brain className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">AI Brain</h1>
              <p className="text-muted-foreground">
                Your studio's intelligent assistant
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            Powered by Historical Wisdom
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
          <TabsList className="bg-secondary mb-4 self-start">
            <TabsTrigger value="chat" className="data-[state=active]:bg-background">
              <MessageSquare className="h-4 w-4 mr-2" />
              Chat
            </TabsTrigger>
            <TabsTrigger value="quick" className="data-[state=active]:bg-background">
              <Sparkles className="h-4 w-4 mr-2" />
              Quick Actions
            </TabsTrigger>
          </TabsList>

          {/* Quick Actions Tab */}
          <TabsContent value="quick" className="flex-1">
            <div className="grid gap-4 md:grid-cols-2">
              {quickActions.map((action) => {
                const Icon = action.icon;
                return (
                  <Card
                    key={action.id}
                    className="glass-card hover-lift cursor-pointer transition-all"
                    onClick={() => handleQuickAction(action)}
                  >
                    <CardHeader>
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                          <Icon className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <CardTitle className="text-lg">{action.title}</CardTitle>
                          <CardDescription>{action.description}</CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                  </Card>
                );
              })}
            </div>

            <Card className="glass-card mt-6">
              <CardContent className="py-8 text-center">
                <Brain className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">Historical Wisdom Engine</h3>
                <p className="text-muted-foreground max-w-md mx-auto">
                  The AI Brain learns from your project history, crew performance, and client patterns 
                  to provide actionable insights and predictions.
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Chat Tab */}
          <TabsContent value="chat" className="flex-1 flex flex-col min-h-0">
            <Card className="glass-card flex-1 flex flex-col min-h-0">
              <CardContent className="flex-1 flex flex-col p-4 min-h-0">
                {/* Messages Area */}
                <div className="flex-1 overflow-y-auto space-y-4 mb-4">
                  {messages.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center p-8">
                      <Brain className="h-16 w-16 text-muted-foreground/30 mb-4" />
                      <h3 className="text-lg font-semibold mb-2">Start a Conversation</h3>
                      <p className="text-muted-foreground max-w-sm">
                        Ask me anything about your projects, clients, or team. I have access to all your historical data.
                      </p>
                      <div className="flex flex-wrap gap-2 mt-4 justify-center">
                        {['Who performed best last quarter?', 'Predict costs for a music video', 'Which clients need attention?'].map((suggestion) => (
                          <Button
                            key={suggestion}
                            variant="outline"
                            size="sm"
                            onClick={() => sendMessage(suggestion)}
                            className="text-xs"
                          >
                            {suggestion}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    messages.map((message) => (
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
                          {message.thoughtTrace && (
                            <div className="mt-2 pt-2 border-t border-border/50 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <HelpCircle className="h-3 w-3" />
                                {message.thoughtTrace.type} • {Math.round(message.thoughtTrace.contextSize / 1000)}k context
                              </span>
                            </div>
                          )}
                        </div>
                        {message.role === 'user' && (
                          <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
                            <span className="text-xs font-medium">
                              {profile?.full_name?.charAt(0) || 'U'}
                            </span>
                          </div>
                        )}
                      </div>
                    ))
                  )}
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

                {/* Input Area */}
                <form onSubmit={handleSubmit} className="flex gap-2">
                  <Input
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder="Ask about projects, crew, clients, or costs..."
                    disabled={isLoading}
                    className="flex-1 bg-input"
                  />
                  <Button type="submit" disabled={isLoading || !inputValue.trim()}>
                    {isLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
