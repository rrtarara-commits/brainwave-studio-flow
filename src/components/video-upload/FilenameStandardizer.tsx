import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { CheckCircle2, FileEdit, AlertCircle, Loader2 } from 'lucide-react';
import { analyzeFilename, FilenameAnalysis } from '@/lib/filename-utils';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { getErrorMessage } from '@/lib/get-error-message';

interface FilenameStandardizerProps {
  uploadId: string;
  currentFilename: string;
  projectCode: string | null;
  storagePath: string | null;
  onRename: (newFilename: string) => void;
}

export function FilenameStandardizer({
  uploadId,
  currentFilename,
  projectCode,
  storagePath,
  onRename,
}: FilenameStandardizerProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const { toast } = useToast();

  const analysis: FilenameAnalysis = analyzeFilename(currentFilename, projectCode);

  const handleRename = async () => {
    if (!analysis.suggestedName || !storagePath) return;

    setIsRenaming(true);
    try {
      // Get the directory path (everything before the filename)
      const pathParts = storagePath.split('/');
      pathParts.pop(); // Remove current filename
      const newStoragePath = [...pathParts, analysis.suggestedName].join('/');

      // Copy file to new name in storage
      const { error: copyError } = await supabase.storage
        .from('video-uploads')
        .copy(storagePath, newStoragePath);

      if (copyError) {
        // If copy fails due to existing file, try to proceed anyway
        if (!copyError.message.includes('already exists')) {
          throw copyError;
        }
      }

      // Delete old file
      await supabase.storage
        .from('video-uploads')
        .remove([storagePath]);

      // Update database record
      const { error: updateError } = await supabase
        .from('video_uploads')
        .update({
          file_name: analysis.suggestedName,
          storage_path: newStoragePath,
        })
        .eq('id', uploadId);

      if (updateError) throw updateError;

      onRename(analysis.suggestedName);

      toast({
        title: 'File renamed',
        description: `Renamed to ${analysis.suggestedName}`,
      });
    } catch (error) {
      console.error('Rename error:', error);
      toast({
        variant: 'destructive',
        title: 'Rename failed',
        description: getErrorMessage(error, 'Could not rename file'),
      });
    } finally {
      setIsRenaming(false);
    }
  };

  // No project code configured
  if (!analysis.hasProjectCode) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              <span>No project code</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p>Set a project code in project settings to enable filename standardization</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // Already standard
  if (analysis.isStandard) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-primary">
        <CheckCircle2 className="h-3 w-3" />
        <span>Standard format</span>
      </div>
    );
  }

  // Can be standardized
  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="text-xs font-normal gap-1">
        <FileEdit className="h-3 w-3" />
        Non-standard
      </Badge>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="sm"
              className="h-6 text-xs px-2"
              onClick={handleRename}
              disabled={isRenaming}
            >
              {isRenaming ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  Renaming...
                </>
              ) : (
                <>Fix Name</>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Rename to: <strong>{analysis.suggestedName}</strong></p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
