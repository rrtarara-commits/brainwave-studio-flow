import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export interface AIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thought_trace?: {
    type: string;
    contextSize: number;
    model: string;
  };
  created_at: string;
}

export interface AIConversation {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export function useAIConversations() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<AIConversation[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Fetch all conversations for the user
  const fetchConversations = useCallback(async () => {
    if (!user) return;
    
    const { data, error } = await supabase
      .from('ai_conversations')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('Error fetching conversations:', error);
      return;
    }

    setConversations(data || []);
  }, [user]);

  // Fetch messages for a specific conversation
  const fetchMessages = useCallback(async (conversationId: string) => {
    const { data, error } = await supabase
      .from('ai_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching messages:', error);
      return;
    }

    setMessages(data?.map(m => ({
      id: m.id,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      thought_trace: m.thought_trace as AIMessage['thought_trace'],
      created_at: m.created_at,
    })) || []);
  }, []);

  // Create a new conversation
  const createConversation = useCallback(async (title?: string): Promise<string | null> => {
    if (!user) return null;

    const { data, error } = await supabase
      .from('ai_conversations')
      .insert({
        user_id: user.id,
        title: title || 'New conversation',
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating conversation:', error);
      return null;
    }

    setConversations(prev => [data, ...prev]);
    setCurrentConversationId(data.id);
    setMessages([]);
    return data.id;
  }, [user]);

  // Add a message to the current conversation
  const addMessage = useCallback(async (
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    thoughtTrace?: AIMessage['thought_trace']
  ): Promise<AIMessage | null> => {
    const { data, error } = await supabase
      .from('ai_messages')
      .insert({
        conversation_id: conversationId,
        role,
        content,
        thought_trace: thoughtTrace,
      })
      .select()
      .single();

    if (error) {
      console.error('Error adding message:', error);
      return null;
    }

    const newMessage: AIMessage = {
      id: data.id,
      role: data.role as 'user' | 'assistant',
      content: data.content,
      thought_trace: data.thought_trace as AIMessage['thought_trace'],
      created_at: data.created_at,
    };

    setMessages(prev => [...prev, newMessage]);

    // Update conversation title from first user message
    if (role === 'user') {
      const existingMessages = messages.filter(m => m.role === 'user');
      if (existingMessages.length === 0) {
        const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
        await supabase
          .from('ai_conversations')
          .update({ title, updated_at: new Date().toISOString() })
          .eq('id', conversationId);
        
        setConversations(prev => prev.map(c => 
          c.id === conversationId ? { ...c, title, updated_at: new Date().toISOString() } : c
        ));
      } else {
        await supabase
          .from('ai_conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', conversationId);
      }
    }

    return newMessage;
  }, [messages]);

  // Select a conversation
  const selectConversation = useCallback(async (conversationId: string) => {
    setCurrentConversationId(conversationId);
    await fetchMessages(conversationId);
  }, [fetchMessages]);

  // Delete a conversation
  const deleteConversation = useCallback(async (conversationId: string) => {
    const { error } = await supabase
      .from('ai_conversations')
      .delete()
      .eq('id', conversationId);

    if (error) {
      console.error('Error deleting conversation:', error);
      return;
    }

    setConversations(prev => prev.filter(c => c.id !== conversationId));
    if (currentConversationId === conversationId) {
      setCurrentConversationId(null);
      setMessages([]);
    }
  }, [currentConversationId]);

  // Start fresh conversation
  const startNewConversation = useCallback(() => {
    setCurrentConversationId(null);
    setMessages([]);
  }, []);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  return {
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
    setMessages,
  };
}
