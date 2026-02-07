import { Brain, Users, DollarSign, AlertTriangle, HelpCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export type AIRequestType = 'chat' | 'crew_recommendation' | 'budget_prediction' | 'sentiment_analysis';

interface QuickAction {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  type: AIRequestType;
  prompt: string;
}

const quickActions: QuickAction[] = [
  {
    id: 'crew',
    title: 'Crew Recommendations',
    description: 'Find the best editor for your next project',
    icon: Users,
    type: 'crew_recommendation',
    prompt: 'Based on our historical data, who would be the best editor for a new commercial project? Consider turnaround time, quality ratings, and availability.',
  },
  {
    id: 'budget',
    title: 'Budget Prediction',
    description: 'Estimate costs based on similar projects',
    icon: DollarSign,
    type: 'budget_prediction',
    prompt: 'I need a cost estimate for a new corporate video project. What should we budget based on our historical project data?',
  },
  {
    id: 'sentiment',
    title: 'Client Insights',
    description: 'Analyze client patterns and risks',
    icon: AlertTriangle,
    type: 'sentiment_analysis',
    prompt: 'Analyze our current project portfolio. Are there any clients or projects showing concerning patterns that we should address proactively?',
  },
  {
    id: 'help',
    title: 'Ask Anything',
    description: 'Query project history and knowledge',
    icon: HelpCircle,
    type: 'chat',
    prompt: '',
  },
];

interface QuickActionsProps {
  onAction: (prompt: string, type: AIRequestType) => void;
}

export function QuickActions({ onAction }: QuickActionsProps) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        {quickActions.map((action) => {
          const Icon = action.icon;
          return (
            <Card
              key={action.id}
              className="glass-card hover-lift cursor-pointer transition-all"
              onClick={() => action.prompt && onAction(action.prompt, action.type)}
            >
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">{action.title}</CardTitle>
                    <CardDescription>{action.description}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          );
        })}
      </div>

      <Card className="glass-card">
        <CardContent className="py-8 text-center">
          <Brain className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">Historical Wisdom Engine</h3>
          <p className="text-muted-foreground max-w-md mx-auto">
            The AI Brain learns from your project history, crew performance, and client patterns 
            to provide actionable insights and predictions.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
