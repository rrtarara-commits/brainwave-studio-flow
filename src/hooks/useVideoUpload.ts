import { useState, useCallback, useEffect, useRef } from 'react';
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
  timestamp?: number | null;
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

export interface DeepAnalysisResult {
  visual?: {
    issues: QCFlag[];
    summary: string;
    qualityScore?: number;
    framesAnalyzed?: number;
  };
  audio?: {
    issues: QCFlag[];
    summary: string;
    averageDialogueDb?: number;
    peakDb?: number;
    silenceGaps?: number;
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
  deepAnalysisStatus?: 'pending' | 'processing' | 'complete' | 'failed';
  visualAnalysis?: DeepAnalysisResult['visual'];
  audioAnalysis?: DeepAnalysisResult['audio'];
}

export function useVideoUpload() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [upload, setUpload] = useState<VideoUpload | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isDeepAnalyzing, setIsDeepAnalyzing] = useState(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Poll for deep analysis results
  const pollDeepAnalysis = useCallback((uploadId: string) => {
    // Clear any existing polling
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    setIsDeepAnalyzing(true);

    pollIntervalRef.current = setInterval(async () => {
      try {
        const { data, error } = await supabase
          .from('video_uploads')
          .select('deep_analysis_status, visual_analysis, audio_analysis, qc_passed')
          .eq('id', uploadId)
          .single();

        if (error) {
          console.error('Poll error:', error);
          return;
        }

        if (data?.deep_analysis_status === 'complete') {
          // Deep analysis is done - update state with results
          setUpload(prev => {
            if (!prev) return prev;
            
            // Merge deep analysis flags into qcResult
            const deepFlags: QCFlag[] = [];
            
            // Type assertion for JSON data from database
            const visualAnalysis = data.visual_analysis as { issues?: unknown[]; summary?: string; qualityScore?: number; framesAnalyzed?: number } | null;
            const audioAnalysis = data.audio_analysis as { issues?: unknown[]; summary?: string; averageDialogueDb?: number; peakDb?: number; silenceGaps?: number } | null;
            
            if (visualAnalysis?.issues && Array.isArray(visualAnalysis.issues)) {
              deepFlags.push(...visualAnalysis.issues.map((f: unknown) => {
                const flag = f as QCFlag;
                return {
                  ...flag,
                  source: 'ai_analysis' as const,
                };
              }));
            }
            
            if (audioAnalysis?.issues && Array.isArray(audioAnalysis.issues)) {
              deepFlags.push(...audioAnalysis.issues.map((f: unknown) => {
                const flag = f as QCFlag;
                return {
                  ...flag,
                  source: 'ai_analysis' as const,
                };
              }));
            }

            const updatedResult = prev.qcResult ? {
              ...prev.qcResult,
              flags: [...prev.qcResult.flags, ...deepFlags],
              passed: data.qc_passed ?? prev.qcResult.passed,
              thoughtTrace: {
                ...prev.qcResult.thoughtTrace,
                visualFramesAnalyzed: visualAnalysis?.framesAnalyzed || 0,
                audioAnalyzed: !!audioAnalysis,
              },
            } : prev.qcResult;

            return {
              ...prev,
              deepAnalysisStatus: 'complete' as const,
              visualAnalysis: visualAnalysis as VideoUpload['visualAnalysis'],
              audioAnalysis: audioAnalysis as VideoUpload['audioAnalysis'],
              qcResult: updatedResult,
              qcPassed: data.qc_passed ?? prev.qcPassed,
            };
          });

          // Stop polling
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setIsDeepAnalyzing(false);

          toast({
            title: 'Deep Analysis Complete',
            description: 'Video visual and audio analysis results are ready for review.',
          });

        } else if (data?.deep_analysis_status === 'failed') {
          // Analysis failed
          setUpload(prev => prev ? { ...prev, deepAnalysisStatus: 'failed' } : null);
          
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setIsDeepAnalyzing(false);

          toast({
            variant: 'destructive',
            title: 'Deep Analysis Failed',
            description: 'Video analysis could not be completed. You can still proceed with the upload.',
          });

        } else if (data?.deep_analysis_status === 'processing') {
          setUpload(prev => prev ? { ...prev, deepAnalysisStatus: 'processing' } : null);
        }

      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 3000); // Poll every 3 seconds

  }, [toast]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

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
          deepAnalysisStatus: 'pending',
        } : null);
        
        // Start polling for deep analysis results
        pollDeepAnalysis(uploadData.id);
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
  }, [toast, pollDeepAnalysis]);

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
    // Clear polling
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setUpload(null);
    setIsUploading(false);
    setIsAnalyzing(false);
    setIsDeepAnalyzing(false);
  }, []);

  return {
    upload,
    isUploading,
    isAnalyzing,
    isDeepAnalyzing,
    uploadVideo,
    dismissFlag,
    submitToFrameio,
    reset,
  };
}
