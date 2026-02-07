import { useState } from 'react';
import { Brain, HelpCircle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface AIPrediction {
  recommendation: 'our_fault' | 'client_scope';
  confidence: number;
  reasoning: string;
  dataPoints: string[];
}

interface ScopeSentinelModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectTitle: string;
  projectId: string;
  aiPrediction?: AIPrediction | null;
  isLoadingPrediction?: boolean;
  onDecision: (isOurFault: boolean) => Promise<void>;
}

export function ScopeSentinelModal({
  open,
  onOpenChange,
  projectTitle,
  projectId,
  aiPrediction,
  isLoadingPrediction = false,
  onDecision,
}: ScopeSentinelModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showThoughtTrace, setShowThoughtTrace] = useState(false);

  const handleDecision = async (isOurFault: boolean) => {
    setIsSubmitting(true);
    try {
      await onDecision(isOurFault);
      onOpenChange(false);
    } catch (error) {
      console.error('Error recording decision:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.8) return 'text-success';
    if (confidence >= 0.5) return 'text-warning';
    return 'text-muted-foreground';
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg glass-card border-border">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-lg bg-warning/20 flex items-center justify-center">
              <Brain className="h-5 w-5 text-warning" />
            </div>
            <div>
              <DialogTitle className="text-xl">Scope Sentinel</DialogTitle>
              <DialogDescription>Revision Classification Required</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Project Info */}
          <div className="p-4 rounded-lg bg-secondary/50">
            <p className="text-sm text-muted-foreground">Project</p>
            <p className="font-medium mt-1">{projectTitle}</p>
          </div>

          {/* The Question */}
          <div className="text-center">
            <h3 className="text-lg font-semibold mb-2">
              Is this revision due to our mistake?
            </h3>
            <p className="text-sm text-muted-foreground">
              This determines whether the revision is billable to the client or absorbed internally.
            </p>
          </div>

          {/* AI Prediction Badge */}
          {isLoadingPrediction ? (
            <div className="flex items-center justify-center p-4 rounded-lg bg-primary/5 border border-primary/20">
              <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
              <span className="text-sm text-muted-foreground">
                Analyzing project history...
              </span>
            </div>
          ) : aiPrediction && (
            <div className="p-4 rounded-lg bg-primary/5 border border-primary/20">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="ai-pulse">
                    <Brain className="h-4 w-4 text-primary" />
                  </div>
                  <span className="text-sm font-medium">AI Prediction</span>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setShowThoughtTrace(!showThoughtTrace)}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <HelpCircle className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>View AI reasoning</TooltipContent>
                </Tooltip>
              </div>

              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    'text-sm px-3 py-1.5 rounded-full font-medium',
                    aiPrediction.recommendation === 'our_fault'
                      ? 'bg-destructive/20 text-destructive'
                      : 'bg-success/20 text-success'
                  )}
                >
                  {aiPrediction.recommendation === 'our_fault'
                    ? 'Likely Our Fault'
                    : 'Likely Client Scope'}
                </span>
                <span className={cn('text-sm', getConfidenceColor(aiPrediction.confidence))}>
                  {Math.round(aiPrediction.confidence * 100)}% confidence
                </span>
              </div>

              {/* Thought Trace (expandable) */}
              {showThoughtTrace && (
                <div className="mt-4 p-3 rounded-lg bg-background/50 space-y-3 animate-in">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                      Reasoning
                    </p>
                    <p className="text-sm">{aiPrediction.reasoning}</p>
                  </div>
                  {aiPrediction.dataPoints.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                        Data Sources
                      </p>
                      <ul className="text-sm space-y-1">
                        {aiPrediction.dataPoints.map((point, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="text-primary">•</span>
                            <span className="text-muted-foreground">{point}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Decision Buttons */}
          <div className="grid grid-cols-2 gap-4">
            <Button
              variant="outline"
              size="lg"
              onClick={() => handleDecision(true)}
              disabled={isSubmitting}
              className={cn(
                'h-auto py-4 flex flex-col items-center gap-2 border-2',
                'hover:border-destructive hover:bg-destructive/10',
                aiPrediction?.recommendation === 'our_fault' && 'border-destructive/50 bg-destructive/5'
              )}
            >
              {isSubmitting ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <>
                  <span className="text-lg font-semibold">Yes</span>
                  <span className="text-xs text-muted-foreground">Our Fault</span>
                </>
              )}
            </Button>

            <Button
              variant="outline"
              size="lg"
              onClick={() => handleDecision(false)}
              disabled={isSubmitting}
              className={cn(
                'h-auto py-4 flex flex-col items-center gap-2 border-2',
                'hover:border-success hover:bg-success/10',
                aiPrediction?.recommendation === 'client_scope' && 'border-success/50 bg-success/5'
              )}
            >
              {isSubmitting ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <>
                  <span className="text-lg font-semibold">No</span>
                  <span className="text-xs text-muted-foreground">Client Scope</span>
                </>
              )}
            </Button>
          </div>

          <p className="text-xs text-center text-muted-foreground">
            This decision will be logged for audit purposes.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
