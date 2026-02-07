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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Upload, CheckCircle2, AlertTriangle, Brain, ExternalLink, Link2, Unlink } from 'lucide-react';
import { VideoDropzone } from './VideoDropzone';
import { QCFlagsList } from './QCFlagsList';
import { useVideoUpload } from '@/hooks/useVideoUpload';
import { useFrameIO } from '@/hooks/useFrameIO';
import { useLocation } from 'react-router-dom';

interface VideoUploadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectTitle: string;
  clientName?: string;
  onComplete?: (frameioLink: string) => void;
}

type Step = 'upload' | 'review' | 'submit' | 'complete';

export function VideoUploadModal({
  open,
  onOpenChange,
  projectId,
  projectTitle,
  clientName,
  onComplete,
}: VideoUploadModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [step, setStep] = useState<Step>('upload');
  const [selectedFrameioProject, setSelectedFrameioProject] = useState<string>('');
  const [manualFeedback, setManualFeedback] = useState<string>('');
  const [useManualEntry, setUseManualEntry] = useState(false);
  const location = useLocation();

  const {
    upload,
    isUploading,
    isAnalyzing,
    uploadVideo,
    dismissFlag,
    submitToFrameio,
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
      setStep('upload');
      setSelectedFrameioProject('');
      setManualFeedback('');
      setUseManualEntry(false);
      reset();
    }
  }, [open, reset]);

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

    await uploadVideo(file, projectId, clientName, feedbackItems.length > 0 ? feedbackItems : undefined);
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
    const link = await submitToFrameio(projectIdToUse);
    
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
      case 'upload': return 1;
      case 'review': return 2;
      case 'submit': return 3;
      case 'complete': return 4;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
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
          {['Upload', 'AI Review', 'Submit', 'Complete'].map((label, i) => (
            <div key={label} className="flex items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  getStepNumber() > i + 1
                    ? 'bg-primary text-primary-foreground'
                    : getStepNumber() === i + 1
                    ? 'bg-primary/20 text-primary border-2 border-primary'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {getStepNumber() > i + 1 ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
              </div>
              <span className="ml-2 text-sm hidden sm:inline">{label}</span>
              {i < 3 && <div className="w-8 h-px bg-border mx-2" />}
            </div>
          ))}
        </div>

        {/* Step Content */}
        {step === 'upload' && (
          <div className="space-y-4">
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
                        Checking against QC standards and reviewing feedback
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
            <div className="flex items-center gap-2 p-3 rounded-lg bg-muted">
              <Brain className="h-5 w-5 text-primary" />
              <div className="flex-1">
                <p className="font-medium">AI Analysis Complete</p>
                <p className="text-xs text-muted-foreground">
                  {upload.qcResult.thoughtTrace.standardsChecked} standards checked • 
                  {upload.qcResult.thoughtTrace.feedbackItemsReviewed} feedback items reviewed
                </p>
              </div>
            </div>

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

            {/* Frame.io Connection Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Frame.io Project</Label>
                {isConnected ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={disconnect}
                    className="text-xs h-7"
                  >
                    <Unlink className="h-3 w-3 mr-1" />
                    Disconnect
                  </Button>
                ) : null}
              </div>

              {!isConnected ? (
                <div className="p-4 border rounded-lg bg-muted/50 space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    <Link2 className="h-4 w-4 text-muted-foreground" />
                    <span>Connect your Frame.io account to upload videos</span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleConnect}
                      disabled={isConnecting}
                      className="flex-1"
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
                    <Button
                      variant="outline"
                      onClick={() => setUseManualEntry(true)}
                    >
                      Use Project ID
                    </Button>
                  </div>
                  {frameioError && (
                    <p className="text-xs text-destructive">{frameioError}</p>
                  )}
                </div>
              ) : frameioProjects.length > 0 && !useManualEntry ? (
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
                    {loadingProjects && isConnected ? 'Loading projects...' : 
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
