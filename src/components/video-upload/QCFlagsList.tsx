import { AlertTriangle, AlertCircle, Info, X, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { QCFlag } from '@/hooks/useVideoUpload';

interface QCFlagsListProps {
  flags: QCFlag[];
  dismissedFlags: string[];
  onDismiss: (flagId: string) => void;
}

export function QCFlagsList({ flags, dismissedFlags, onDismiss }: QCFlagsListProps) {
  const activeFlags = flags.filter(f => !dismissedFlags.includes(f.id));
  const dismissed = flags.filter(f => dismissedFlags.includes(f.id));

  const getIcon = (type: 'error' | 'warning' | 'info') => {
    switch (type) {
      case 'error':
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      case 'warning':
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      case 'info':
        return <Info className="h-4 w-4 text-blue-500" />;
    }
  };

  const getBadgeVariant = (type: 'error' | 'warning' | 'info') => {
    switch (type) {
      case 'error':
        return 'destructive';
      case 'warning':
        return 'outline';
      case 'info':
        return 'secondary';
    }
  };

  if (flags.length === 0) {
    return (
      <Card className="border-green-500/50 bg-green-500/5">
        <CardContent className="p-4 flex items-center gap-3">
          <Check className="h-5 w-5 text-green-500" />
          <div>
            <p className="font-medium text-green-700 dark:text-green-400">All checks passed!</p>
            <p className="text-sm text-muted-foreground">No issues found with your video.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {activeFlags.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-yellow-500" />
            Issues to Review ({activeFlags.length})
          </h4>
          <ScrollArea className="max-h-64">
            <div className="space-y-2">
              {activeFlags.map((flag) => (
                <Card
                  key={flag.id}
                  className={cn(
                    'border-l-4',
                    flag.type === 'error' && 'border-l-destructive',
                    flag.type === 'warning' && 'border-l-yellow-500',
                    flag.type === 'info' && 'border-l-blue-500'
                  )}
                >
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 flex-1">
                        {getIcon(flag.type)}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{flag.title}</span>
                            <Badge variant={getBadgeVariant(flag.type)} className="text-xs">
                              {flag.category}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground mt-1">
                            {flag.description}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Source: {flag.source.replace('_', ' ')}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onDismiss(flag.id)}
                        className="flex-shrink-0 text-xs"
                      >
                        <X className="h-3 w-3 mr-1" />
                        Dismiss
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}

      {dismissed.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2 text-muted-foreground">
            Dismissed ({dismissed.length})
          </h4>
          <div className="space-y-1">
            {dismissed.map((flag) => (
              <div
                key={flag.id}
                className="flex items-center gap-2 text-sm text-muted-foreground line-through opacity-60"
              >
                {getIcon(flag.type)}
                <span>{flag.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
