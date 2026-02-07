import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';

export interface QCFlag {
  id: string;
  type: 'error' | 'warning' | 'info';
  category: string;
  title: string;
  description: string;
  source: string;
  ruleId?: string;
}

export interface QCResult {
  passed: boolean;
  flags: QCFlag[];
  metadata: Record<string, unknown>;
  analyzedAt: string;
  thoughtTrace: {
    standardsChecked: number;
    feedbackItemsReviewed: number;
    aiModel: string;
    visualFramesAnalyzed: number;
    audioAnalyzed: boolean;
  };
}

export interface VideoUpload {
  id: string;
  projectId: string;
  fileName: string;
  fileSize: number;
  status: 'pending' | 'analyzing' | 'reviewed' | 'uploading' | 'completed' | 'failed';
  qcResult?: QCResult;
  qcPassed?: boolean;
  dismissedFlags: string[];
  frameioLink?: string;
}

export function useVideoUpload() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [upload, setUpload] = useState<VideoUpload | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Upload file to storage and create record
  const uploadVideo = useCallback(async (
    file: File,
    projectId: string,
    clientName?: string,
    frameioFeedback?: string[]
  ) => {
    if (!user) {
      toast({ variant: 'destructive', title: 'Error', description: 'You must be logged in' });
      return null;
    }

    setIsUploading(true);

    try {
      // Create upload record first
      const { data: uploadRecord, error: recordError } = await supabase
        .from('video_uploads')
        .insert({
          project_id: projectId,
          uploader_id: user.id,
          file_name: file.name,
          file_size: file.size,
          status: 'pending',
          frameio_feedback: frameioFeedback ? { items: frameioFeedback } : null,
        })
        .select()
        .single();

      if (recordError) throw recordError;

      // Upload to storage
      const storagePath = `${user.id}/${uploadRecord.id}/${file.name}`;
      const { error: storageError } = await supabase.storage
        .from('video-uploads')
        .upload(storagePath, file);

      if (storageError) throw storageError;

      // Update record with storage path
      await supabase
        .from('video_uploads')
        .update({ storage_path: storagePath })
        .eq('id', uploadRecord.id);

      const newUpload: VideoUpload = {
        id: uploadRecord.id,
        projectId,
        fileName: file.name,
        fileSize: file.size,
        status: 'pending',
        dismissedFlags: [],
      };

      setUpload(newUpload);
      setIsUploading(false);

      // Start QC analysis
      await analyzeVideo(newUpload, storagePath, clientName, frameioFeedback);

      return newUpload;
    } catch (error) {
      console.error('Upload error:', error);
      toast({
        variant: 'destructive',
        title: 'Upload Failed',
        description: error instanceof Error ? error.message : 'Failed to upload video',
      });
      setIsUploading(false);
      return null;
    }
  }, [user, toast]);

  // Run QC analysis
  const analyzeVideo = useCallback(async (
    uploadData: VideoUpload,
    storagePath: string,
    clientName?: string,
    frameioFeedback?: string[]
  ) => {
    setIsAnalyzing(true);
    setUpload(prev => prev ? { ...prev, status: 'analyzing' } : null);

    try {
      const { data, error } = await supabase.functions.invoke('video-qc', {
        body: {
          uploadId: uploadData.id,
          projectId: uploadData.projectId,
          fileName: uploadData.fileName,
          storagePath,
          clientName,
          frameioFeedback,
        },
      });

      if (error) throw error;

      if (data?.success) {
        setUpload(prev => prev ? {
          ...prev,
          status: 'reviewed',
          qcResult: data.result,
          qcPassed: data.result.passed,
        } : null);
      } else {
        throw new Error(data?.error || 'QC analysis failed');
      }
    } catch (error) {
      console.error('QC analysis error:', error);
      toast({
        variant: 'destructive',
        title: 'Analysis Failed',
        description: error instanceof Error ? error.message : 'QC analysis failed',
      });
      setUpload(prev => prev ? { ...prev, status: 'failed' } : null);
    } finally {
      setIsAnalyzing(false);
    }
  }, [toast]);

  // Dismiss a flag
  const dismissFlag = useCallback((flagId: string) => {
    setUpload(prev => {
      if (!prev) return null;
      const newDismissed = [...prev.dismissedFlags, flagId];
      
      // Update in database
      supabase
        .from('video_uploads')
        .update({ dismissed_flags: newDismissed })
        .eq('id', prev.id);

      return { ...prev, dismissedFlags: newDismissed };
    });
  }, []);

  // Submit to Frame.io
  const submitToFrameio = useCallback(async (frameioProjectId: string) => {
    if (!upload) return null;

    setUpload(prev => prev ? { ...prev, status: 'uploading' } : null);

    try {
      const { data, error } = await supabase.functions.invoke('frameio', {
        body: {
          action: 'upload',
          projectId: upload.projectId,
          frameioProjectId,
          uploadId: upload.id,
          fileName: upload.fileName,
          fileSize: upload.fileSize,
        },
      });

      if (error) throw error;

      if (data?.success) {
        const frameioLink = data.data.shareLink;
        setUpload(prev => prev ? {
          ...prev,
          status: 'completed',
          frameioLink,
        } : null);

        toast({
          title: 'Success!',
          description: 'Video uploaded to Frame.io successfully',
        });

        return frameioLink;
      } else {
        throw new Error(data?.error || 'Frame.io upload failed');
      }
    } catch (error) {
      console.error('Frame.io submit error:', error);
      toast({
        variant: 'destructive',
        title: 'Submission Failed',
        description: error instanceof Error ? error.message : 'Failed to submit to Frame.io',
      });
      setUpload(prev => prev ? { ...prev, status: 'failed' } : null);
      return null;
    }
  }, [upload, toast]);

  // Reset state
  const reset = useCallback(() => {
    setUpload(null);
    setIsUploading(false);
    setIsAnalyzing(false);
  }, []);

  return {
    upload,
    isUploading,
    isAnalyzing,
    uploadVideo,
    dismissFlag,
    submitToFrameio,
    reset,
  };
}
