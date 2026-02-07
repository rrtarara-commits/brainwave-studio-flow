import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { AppRole } from '@/lib/types';
import { Loader2 } from 'lucide-react';

interface ProtectedRouteProps {
  children: ReactNode;
  requiredRole?: AppRole | AppRole[];
  requireResourceAccess?: boolean;
  requireFootageAccess?: boolean;
}

export function ProtectedRoute({
  children,
  requiredRole,
  requireResourceAccess,
  requireFootageAccess,
}: ProtectedRouteProps) {
  const { user, role, isLoading, isAdmin, canManageResources, canUploadFootage } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Check role requirements
  if (requiredRole) {
    const roles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
    if (!role || !roles.includes(role)) {
      return <Navigate to="/dashboard" replace />;
    }
  }

  // Check specialist access requirements
  if (requireResourceAccess && !canManageResources && !isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  if (requireFootageAccess && !canUploadFootage && !isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
