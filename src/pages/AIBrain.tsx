import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Brain, Send, Loader2, MessageSquare, Sparkles } from 'lucide-react';
import { useAIConversations } from '@/hooks/useAIConversations';
import { ConversationSidebar } from '@/components/ai-brain/ConversationSidebar';
import { ChatMessages } from '@/components/ai-brain/ChatMessages';
import { QuickActions, type AIRequestType } from '@/components/ai-brain/QuickActions';
import { invokeBackendFunction } from '@/lib/api/invoke-backend-function';

export default function AIBrain() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [inputValue, setInputValue] = useState('');
  const [activeTab, setActiveTab] = useState('chat');
  
  const {
    conversations,
    currentConversationId,
    messages,
    isLoading,
    setIsLoading,
    createConversation,
    addMessage,
    selectConversation,
    deleteConversation,
    startNewConversation,
  } = useAIConversations();

  const sendMessage = async (content: string, type: AIRequestType = 'chat') => {
    if (!content.trim()) return;

    let conversationId = currentConversationId;
    
    // Create new conversation if needed
    if (!conversationId) {
      conversationId = await createConversation();
      if (!conversationId) {
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to create conversation',
        });
        return;
      }
    }

    // Add user message
    const userMessage = await addMessage(conversationId, 'user', content);
    if (!userMessage) return;

    setInputValue('');
    setIsLoading(true);

    try {
      const { data, error } = await invokeBackendFunction('ai-brain', {
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
        await addMessage(conversationId, 'assistant', data.response, data.thoughtTrace);
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

  const handleQuickAction = (prompt: string, type: AIRequestType) => {
    sendMessage(prompt, type);
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
            <QuickActions onAction={handleQuickAction} />
          </TabsContent>

          {/* Chat Tab */}
          <TabsContent value="chat" className="flex-1 flex min-h-0">
            {/* Conversation Sidebar */}
            <ConversationSidebar
              conversations={conversations}
              currentConversationId={currentConversationId}
              onSelect={selectConversation}
              onNew={startNewConversation}
              onDelete={deleteConversation}
            />
            
            {/* Main Chat Area */}
            <Card className="glass-card flex-1 flex flex-col min-h-0 rounded-l-none border-l-0">
              <CardContent className="flex-1 flex flex-col p-0 min-h-0">
                <ChatMessages
                  messages={messages}
                  isLoading={isLoading}
                  userInitial={profile?.full_name?.charAt(0) || 'U'}
                  onSuggestionClick={(suggestion) => sendMessage(suggestion)}
                />

                {/* Input Area */}
                <form onSubmit={handleSubmit} className="flex gap-2 p-4 border-t border-border">
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
