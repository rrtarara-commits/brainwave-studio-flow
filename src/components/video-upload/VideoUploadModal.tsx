import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Upload, CheckCircle2, AlertTriangle, Brain, ExternalLink, Link2, Zap, Search, MessageSquare } from 'lucide-react';
import { VideoDropzone } from './VideoDropzone';
import { QCFlagsList } from './QCFlagsList';
import { FilenameStandardizer } from './FilenameStandardizer';
import { useVideoUpload, AnalysisMode } from '@/hooks/useVideoUpload';
import { useFrameIO } from '@/hooks/useFrameIO';
import { useLocation } from 'react-router-dom';

interface VideoUploadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectTitle: string;
  clientName?: string;
  projectCode?: string | null;
  onComplete?: (frameioLink: string) => void;
}

type Step = 'connect' | 'upload' | 'review' | 'submit' | 'complete';

export function VideoUploadModal({
  open,
  onOpenChange,
  projectId,
  projectTitle,
  clientName,
  projectCode,
  onComplete,
}: VideoUploadModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [step, setStep] = useState<Step>('upload');
  const [selectedFrameioProject, setSelectedFrameioProject] = useState<string>('');
  const [manualFeedback, setManualFeedback] = useState<string>('');
  const [useManualEntry, setUseManualEntry] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('thorough');
  const [includeQcComments, setIncludeQcComments] = useState(true);
  const location = useLocation();

  const {
    upload,
    isUploading,
    isAnalyzing,
    isDeepAnalyzing,
    uploadVideo,
    dismissFlag,
    submitToFrameio,
    updateFilename,
    reset,
  } = useVideoUpload();

  const { 
    projects: frameioProjects, 
    isLoading: loadingProjects,
    isConnected,
    isConnecting,
    connect,
    disconnect,
    error: frameioError,
  } = useFrameIO();

  // Reset when modal opens/closes
  useEffect(() => {
    if (!open) {
      setSelectedFile(null);
      setStep(isConnected ? 'upload' : 'connect');
      setSelectedFrameioProject('');
      setManualFeedback('');
      setUseManualEntry(false);
      setAnalysisMode('thorough');
      reset();
    }
  }, [open, reset, isConnected]);

  // Set initial step based on connection status
  useEffect(() => {
    if (open && step === 'connect' && isConnected) {
      setStep('upload');
    } else if (open && step === 'upload' && !isConnected && !loadingProjects) {
      setStep('connect');
    }
  }, [open, isConnected, loadingProjects, step]);

  // Update step based on upload status
  useEffect(() => {
    if (upload) {
      if (upload.status === 'reviewed') {
        setStep('review');
      } else if (upload.status === 'completed' && upload.frameioLink) {
        setStep('complete');
      }
    }
  }, [upload?.status]);

  const handleFileSelect = async (file: File) => {
    setSelectedFile(file);
    
    // Parse manual feedback if provided
    const feedbackItems = manualFeedback
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    await uploadVideo(file, projectId, clientName, feedbackItems.length > 0 ? feedbackItems : undefined, analysisMode);
  };

  // Extract Frame.io project ID from URL or raw ID
  const extractFrameioProjectId = (input: string): string => {
    // Match UUID pattern in the input (handles full URLs or raw IDs)
    const uuidMatch = input.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
    return uuidMatch ? uuidMatch[0] : input.trim();
  };

  const handleSubmit = async () => {
    if (!selectedFrameioProject) return;
    
    const projectIdToUse = extractFrameioProjectId(selectedFrameioProject);
    setStep('submit');
    const link = await submitToFrameio(projectIdToUse, includeQcComments);
    
    if (link) {
      onComplete?.(link);
    }
  };

  const handleConnect = () => {
    connect(location.pathname);
  };

  const hasBlockingErrors = upload?.qcResult?.flags.some(
    f => f.type === 'error' && !upload.dismissedFlags.includes(f.id)
  );

  const getStepNumber = () => {
    switch (step) {
      case 'connect': return 1;
      case 'upload': return 2;
      case 'review': return 3;
      case 'submit': return 4;
      case 'complete': return 5;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Upload Video for Review
          </DialogTitle>
          <DialogDescription>
            {projectTitle} {clientName && `• ${clientName}`}
          </DialogDescription>
        </DialogHeader>

        {/* Progress Steps */}
        <div className="flex items-center justify-between mb-4">
          {['Connect', 'Upload', 'AI Review', 'Submit', 'Complete'].map((label, i) => (
            <div key={label} className="flex items-center">
              <div
                className={`w-6 h-6 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-xs sm:text-sm font-medium ${
                  getStepNumber() > i + 1
                    ? 'bg-primary text-primary-foreground'
                    : getStepNumber() === i + 1
                    ? 'bg-primary/20 text-primary border-2 border-primary'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {getStepNumber() > i + 1 ? <CheckCircle2 className="h-3 w-3 sm:h-4 sm:w-4" /> : i + 1}
              </div>
              <span className="ml-1 sm:ml-2 text-xs sm:text-sm hidden md:inline">{label}</span>
              {i < 4 && <div className="w-4 sm:w-8 h-px bg-border mx-1 sm:mx-2" />}
            </div>
          ))}
        </div>

        {/* Step Content */}
        {step === 'connect' && (
          <div className="space-y-4">
            <div className="text-center py-6">
              <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
                <Link2 className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold mb-2">Connect Frame.io First</h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                Before uploading videos, you'll need to connect your Frame.io account so we know where to send them.
              </p>
            </div>

            <div className="p-4 border rounded-lg bg-muted/50 space-y-3">
              <div className="flex gap-2">
                <Button
                  onClick={handleConnect}
                  disabled={isConnecting}
                  className="flex-1"
                  size="lg"
                >
                  {isConnecting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      <Link2 className="h-4 w-4 mr-2" />
                      Connect Frame.io
                    </>
                  )}
                </Button>
              </div>
              {frameioError && (
                <p className="text-xs text-destructive text-center">{frameioError}</p>
              )}
            </div>
          </div>
        )}

        {step === 'upload' && (
          <div className="space-y-4">
            {/* Analysis Mode Toggle */}
            <div className="flex items-center justify-between p-4 rounded-lg border bg-muted/30">
              <div className="flex items-center gap-3">
                {analysisMode === 'quick' ? (
                  <Zap className="h-5 w-5 text-amber-500" />
                ) : (
                  <Search className="h-5 w-5 text-primary" />
                )}
                <div>
                  <p className="font-medium">
                    {analysisMode === 'quick' ? 'Quick Review' : 'Thorough Analysis'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {analysisMode === 'quick' 
                      ? 'Fast check (5 frames, basic audio)' 
                      : 'Full scan (15+ frames, flash/freeze detection, scene analysis)'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Quick</span>
                <Switch
                  checked={analysisMode === 'thorough'}
                  onCheckedChange={(checked) => setAnalysisMode(checked ? 'thorough' : 'quick')}
                />
                <span className="text-xs text-muted-foreground">Thorough</span>
              </div>
            </div>

            <Tabs defaultValue="upload">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="upload">Upload Video</TabsTrigger>
                <TabsTrigger value="feedback">Frame.io Feedback</TabsTrigger>
              </TabsList>
              
              <TabsContent value="upload" className="mt-4">
                <VideoDropzone
                  onFileSelect={handleFileSelect}
                  isDisabled={isUploading || isAnalyzing}
                  isUploading={isUploading}
                  selectedFile={selectedFile}
                  onClear={() => setSelectedFile(null)}
                />
                
                {isAnalyzing && (
                  <div className="mt-4 flex items-center gap-3 p-4 bg-muted rounded-lg">
                    <Brain className="h-5 w-5 text-primary animate-pulse" />
                    <div>
                      <p className="font-medium">AI is analyzing your video...</p>
                      <p className="text-sm text-muted-foreground">
                        {analysisMode === 'quick' 
                          ? 'Running quick review...' 
                          : 'Checking against QC standards and reviewing feedback'}
                      </p>
                    </div>
                    <Loader2 className="h-5 w-5 animate-spin ml-auto" />
                  </div>
                )}
              </TabsContent>
              
              <TabsContent value="feedback" className="mt-4">
                <div className="space-y-2">
                  <Label htmlFor="feedback">
                    Paste Frame.io feedback (optional)
                  </Label>
                  <textarea
                    id="feedback"
                    value={manualFeedback}
                    onChange={(e) => setManualFeedback(e.target.value)}
                    placeholder="Paste feedback comments here, one per line...&#10;[0:15] Fix the transition&#10;[1:30] Color grade needs work"
                    className="w-full h-32 p-3 text-sm border rounded-md bg-background resize-none"
                  />
                  <p className="text-xs text-muted-foreground">
                    AI will verify these items were addressed in your new version
                  </p>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        )}

        {step === 'review' && upload?.qcResult && (
          <div className="space-y-4">
            {/* Filename & Standardization */}
            <div className="p-3 rounded-lg bg-muted/50 border border-border">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground mb-0.5">File name</p>
                  <p className="text-sm font-medium truncate">{upload.fileName}</p>
                </div>
                <FilenameStandardizer
                  uploadId={upload.id}
                  currentFilename={upload.fileName}
                  projectCode={projectCode || null}
                  storagePath={upload.storagePath || null}
                  onRename={(newName) => {
                    // Compute new storage path
                    const pathParts = (upload.storagePath || '').split('/');
                    pathParts.pop();
                    const newStoragePath = [...pathParts, newName].join('/');
                    updateFilename(newName, newStoragePath);
                  }}
                />
              </div>
              <div className="pt-2 border-t border-border mt-2">
                <p className="text-xs text-muted-foreground mb-1">Upload ID</p>
                <code className="text-xs font-mono text-foreground break-all select-all">
                  {upload.id}
                </code>
              </div>
            </div>

            <div className="flex items-center gap-2 p-3 rounded-lg bg-muted">
              <Brain className="h-5 w-5 text-primary" />
              <div className="flex-1">
                <p className="font-medium">AI Analysis Complete</p>
                <p className="text-xs text-muted-foreground">
                  {upload.qcResult.thoughtTrace.standardsChecked} standards • 
                  {upload.qcResult.thoughtTrace.feedbackItemsReviewed} feedback items • 
                  {upload.qcResult.thoughtTrace.visualFramesAnalyzed > 0 ? 'Visual ✓' : ''} 
                  {upload.qcResult.thoughtTrace.audioAnalyzed ? ' Audio ✓' : ''}
                </p>
              </div>
            </div>

            {/* Deep Analysis Status */}
            {isDeepAnalyzing && (
              <div className="flex items-center gap-3 p-4 bg-primary/5 border border-primary/20 rounded-lg animate-pulse">
                <Loader2 className="h-5 w-5 text-primary animate-spin" />
                <div className="flex-1">
                  <p className="font-medium text-primary">Deep Analysis in Progress</p>
                  <p className="text-xs text-muted-foreground">
                    Analyzing video frames and audio levels with AI...
                  </p>
                </div>
              </div>
            )}

            {upload.deepAnalysisStatus === 'complete' && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/10 border border-primary/20">
                <CheckCircle2 className="h-5 w-5 text-primary" />
                <div className="flex-1">
                  <p className="font-medium">Deep Analysis Complete</p>
                  <p className="text-xs text-muted-foreground">
                    {upload.visualAnalysis?.framesAnalyzed || 0} frames analyzed • 
                    {upload.audioAnalysis ? ' Audio levels checked' : ''}
                  </p>
                </div>
              </div>
            )}

            {upload.deepAnalysisStatus === 'failed' && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                <div className="flex-1">
                  <p className="font-medium text-destructive">Deep Analysis Unavailable</p>
                  <p className="text-xs text-muted-foreground">
                    Video analysis could not be completed. You can still proceed with the upload.
                  </p>
                </div>
              </div>
            )}

            <QCFlagsList
              flags={upload.qcResult.flags}
              dismissedFlags={upload.dismissedFlags}
              onDismiss={dismissFlag}
            />

            {hasBlockingErrors && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive">
                <AlertTriangle className="h-4 w-4" />
                <p className="text-sm">
                  You have unresolved errors. Dismiss them to proceed or fix the issues.
                </p>
              </div>
            )}

            {/* QC Comments Toggle */}
            {upload.qcResult.flags.filter(f => !upload.dismissedFlags.includes(f.id)).length > 0 && (
              <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
                <div className="flex items-center gap-3">
                  <MessageSquare className="h-5 w-5 text-primary" />
                  <div>
                    <p className="font-medium text-sm">Attach QC Notes as Comments</p>
                    <p className="text-xs text-muted-foreground">
                      {upload.qcResult.flags.filter(f => !upload.dismissedFlags.includes(f.id)).length} notes will be added to Frame.io with timestamps
                    </p>
                  </div>
                </div>
                <Switch
                  checked={includeQcComments}
                  onCheckedChange={setIncludeQcComments}
                />
              </div>
            )}

            {/* Frame.io Project Selection - Already connected */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Select Frame.io Project</Label>
                <div className="flex items-center gap-2 text-xs text-primary">
                  <CheckCircle2 className="h-3 w-3" />
                  Connected
                </div>
              </div>

              {frameioProjects.length > 0 && !useManualEntry ? (
                <div className="space-y-2">
                  <Select
                    value={selectedFrameioProject}
                    onValueChange={setSelectedFrameioProject}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={loadingProjects ? 'Loading...' : 'Select a project'} />
                    </SelectTrigger>
                    <SelectContent>
                      {frameioProjects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} ({p.teamName})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setUseManualEntry(true)}
                    className="text-xs p-0 h-auto"
                  >
                    Or enter Project ID manually
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Input
                    value={selectedFrameioProject}
                    onChange={(e) => setSelectedFrameioProject(e.target.value)}
                    placeholder="Paste Frame.io URL or Project ID"
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    {loadingProjects ? 'Loading projects...' : 
                      'Paste the full Frame.io URL or just the Project ID (UUID)'}
                  </p>
                  {frameioProjects.length > 0 && (
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => setUseManualEntry(false)}
                      className="text-xs p-0 h-auto"
                    >
                      Select from your projects instead
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {step === 'submit' && (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="h-12 w-12 text-primary animate-spin mb-4" />
            <p className="font-medium">Uploading to Frame.io...</p>
            <p className="text-sm text-muted-foreground">This may take a moment</p>
          </div>
        )}

        {step === 'complete' && upload?.frameioLink && (
          <div className="flex flex-col items-center justify-center py-8">
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <CheckCircle2 className="h-8 w-8 text-primary" />
            </div>
            <p className="font-medium text-lg">Upload Complete!</p>
            <p className="text-sm text-muted-foreground mb-4">
              Your video has been uploaded to Frame.io
            </p>
            <Button variant="outline" asChild>
              <a href={upload.frameioLink} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 mr-2" />
                Open in Frame.io
              </a>
            </Button>
          </div>
        )}

        <DialogFooter>
          {step === 'review' && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!selectedFrameioProject || hasBlockingErrors}
              >
                Submit to Frame.io
              </Button>
            </>
          )}
          {step === 'complete' && (
            <Button onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
