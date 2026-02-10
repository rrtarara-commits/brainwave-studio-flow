import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';

export type AnalysisMode = 'quick' | 'thorough';

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

export interface DeepAnalysisProgress {
  percent: number;
  stage: string;
}

export interface VideoUpload {
  id: string;
  projectId: string;
  fileName: string;
  fileSize: number;
  storagePath: string | null;
  status: 'pending' | 'analyzing' | 'reviewed' | 'uploading' | 'completed' | 'failed';
  qcResult?: QCResult;
  qcPassed?: boolean;
  dismissedFlags: string[];
  frameioLink?: string;
  deepAnalysisStatus?: 'pending' | 'processing' | 'complete' | 'failed';
  deepAnalysisProgress?: DeepAnalysisProgress;
  visualAnalysis?: DeepAnalysisResult['visual'];
  audioAnalysis?: DeepAnalysisResult['audio'];
  analysisMode?: AnalysisMode;
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
          .select('status, deep_analysis_status, deep_analysis_progress, visual_analysis, audio_analysis, qc_passed, qc_result')
          .eq('id', uploadId)
          .single();

        if (error) {
          console.error('Poll error:', error);
          return;
        }

        if (data?.deep_analysis_status === 'completed' || data?.deep_analysis_status === 'complete') {
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

            // Use DB qcResult as source of truth if available, fallback to local merge
            const dbQcResult = data.qc_result as Record<string, unknown> | null;
            let updatedResult: QCResult | undefined;

            if (dbQcResult && dbQcResult.flags) {
              // DB has the fully merged result from the callback — use it directly
              updatedResult = {
                passed: (dbQcResult.passed as boolean) ?? prev.qcResult?.passed ?? true,
                flags: (dbQcResult.flags as QCFlag[]) ?? [],
                metadata: (dbQcResult.metadata as Record<string, unknown>) ?? prev.qcResult?.metadata ?? {},
                analyzedAt: (dbQcResult.analyzedAt as string) ?? prev.qcResult?.analyzedAt ?? '',
                thoughtTrace: {
                  standardsChecked: ((dbQcResult.thoughtTrace as Record<string, unknown>)?.standardsChecked as number) ?? prev.qcResult?.thoughtTrace?.standardsChecked ?? 0,
                  feedbackItemsReviewed: ((dbQcResult.thoughtTrace as Record<string, unknown>)?.feedbackItemsReviewed as number) ?? prev.qcResult?.thoughtTrace?.feedbackItemsReviewed ?? 0,
                  aiModel: ((dbQcResult.thoughtTrace as Record<string, unknown>)?.aiModel as string) ?? prev.qcResult?.thoughtTrace?.aiModel ?? '',
                  visualFramesAnalyzed: visualAnalysis?.framesAnalyzed || 0,
                  audioAnalyzed: !!audioAnalysis,
                },
              };
            } else if (prev.qcResult) {
              updatedResult = {
                ...prev.qcResult,
                flags: [...prev.qcResult.flags, ...deepFlags],
                passed: data.qc_passed ?? prev.qcResult.passed,
                thoughtTrace: {
                  ...prev.qcResult.thoughtTrace,
                  visualFramesAnalyzed: visualAnalysis?.framesAnalyzed || 0,
                  audioAnalyzed: !!audioAnalysis,
                },
              };
            }

            // Reconcile primary status — if DB says 'reviewed', use it
            const reconciledStatus = (data.status === 'reviewed' ? 'reviewed' : prev.status) as VideoUpload['status'];

            return {
              ...prev,
              status: reconciledStatus,
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
          const progress = data.deep_analysis_progress as unknown as DeepAnalysisProgress | null;
          setUpload(prev => prev ? { 
            ...prev, 
            deepAnalysisStatus: 'processing',
            deepAnalysisProgress: progress || prev.deepAnalysisProgress,
          } : null);
        } else {
          // Even in pending/other states, update progress if available
          const progress = data?.deep_analysis_progress as unknown as DeepAnalysisProgress | null;
          if (progress && progress.percent > 0) {
            setUpload(prev => prev ? { ...prev, deepAnalysisProgress: progress } : null);
          }
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
    frameioFeedback?: string[],
    analysisMode: AnalysisMode = 'thorough'
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
        storagePath,
        status: 'pending',
        dismissedFlags: [],
        analysisMode,
      };

      setUpload(newUpload);
      setIsUploading(false);

      // Start QC analysis
      await analyzeVideo(newUpload, storagePath, clientName, frameioFeedback, analysisMode);

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
    frameioFeedback?: string[],
    analysisMode: AnalysisMode = 'thorough'
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
          analysisMode,
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

  // Submit to Frame.io with optional QC comments
  const submitToFrameio = useCallback(async (
    frameioProjectId: string,
    includeComments: boolean = false
  ) => {
    if (!upload) return null;

    setUpload(prev => prev ? { ...prev, status: 'uploading' } : null);

    try {
      // Prepare QC comments if requested
      let qcComments: Array<{
        text: string;
        timestamp?: number | null;
        type?: 'error' | 'warning' | 'info';
        category?: string;
      }> | undefined;

      if (includeComments && upload.qcResult?.flags) {
        // Filter out dismissed flags and map to comment format
        qcComments = upload.qcResult.flags
          .filter(f => !upload.dismissedFlags.includes(f.id))
          .map(f => ({
            text: `${f.title}: ${f.description}`,
            timestamp: f.timestamp ?? null,
            type: f.type,
            category: f.category,
          }));
      }

      const { data, error } = await supabase.functions.invoke('frameio', {
        body: {
          action: 'upload',
          projectId: upload.projectId,
          frameioProjectId,
          uploadId: upload.id,
          fileName: upload.fileName,
          fileSize: upload.fileSize,
          qcComments,
        },
      });

      if (error) throw error;

      if (data?.success) {
        const frameioLink = data.data.shareLink;
        const commentsQueued = data.data.commentsQueued || 0;
        const versionStacked = data.data.versionStacked || false;
        
        setUpload(prev => prev ? {
          ...prev,
          status: 'completed',
          frameioLink,
        } : null);

        let description = 'Video uploaded to Frame.io successfully';
        if (versionStacked && commentsQueued > 0) {
          description = `New version stacked with ${commentsQueued} QC notes attached`;
        } else if (versionStacked) {
          description = 'New version added to version stack';
        } else if (commentsQueued > 0) {
          description = `Video uploaded with ${commentsQueued} QC notes attached`;
        }

        toast({
          title: 'Success!',
          description,
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

  // Update filename after rename
  const updateFilename = useCallback((newFilename: string, newStoragePath: string) => {
    setUpload(prev => prev ? { 
      ...prev, 
      fileName: newFilename,
      storagePath: newStoragePath,
    } : null);
  }, []);

  return {
    upload,
    isUploading,
    isAnalyzing,
    isDeepAnalyzing,
    uploadVideo,
    dismissFlag,
    submitToFrameio,
    updateFilename,
    reset,
  };
}
